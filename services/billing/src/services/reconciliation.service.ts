/**
 * Resolving charges whose outcome we never learned.
 *
 * Every other part of the billing system is careful to record "we do not know"
 * rather than guessing. This is what eventually turns those into an answer.
 *
 * It only ever ASKS the provider. It never re-submits, never assumes, and never
 * resolves an ambiguity by picking the likelier option - because the ambiguity
 * is between "the customer paid" and "the customer did not", and being wrong in
 * either direction is a real harm to a real person.
 *
 * What makes this hard is that iCount has no merchant reference on a
 * transaction, so a lookup cannot say "this is OUR charge". Matching is by
 * amount and card, which genuinely cannot distinguish two identical legitimate
 * charges. When it cannot tell, it escalates to a human rather than deciding.
 */
import { prisma } from "@chatcenter/shared";
import { decryptPaymentToken } from "@chatcenter/shared";
import { getProvider } from "../providers";
import { reconcileUnknown } from "./payment-attempt.service";
import { emitBillingEvent } from "../lib/events";

/** How long to leave an unknown alone before asking. */
export const RECONCILE_AFTER_MS = 60_000;

/** A bound per sweep, so one bad run cannot hammer the provider. */
export const MAX_PER_SWEEP = 25;

export interface SweepResult {
  examined: number;
  resolvedPaid: number;
  resolvedUnpaid: number;
  escalated: number;
}

/**
 * Ask the provider about every attempt whose outcome is unknown.
 *
 * Deliberately delayed: a charge submitted seconds ago may still be settling,
 * and asking too early gets a confident "no transaction" for one that is about
 * to appear - which would mark a paid customer unpaid.
 */
export async function sweepUnknownAttempts(now: Date = new Date()): Promise<SweepResult> {
  const cutoff = new Date(now.getTime() - RECONCILE_AFTER_MS);

  const stuck = await prisma.paymentAttempt.findMany({
    where: {
      state: { in: ["UNKNOWN", "RECONCILIATION_REQUIRED"] },
      updatedAt: { lte: cutoff },
    },
    orderBy: { updatedAt: "asc" },
    take: MAX_PER_SWEEP,
  });

  const result: SweepResult = { examined: 0, resolvedPaid: 0, resolvedUnpaid: 0, escalated: 0 };

  for (const attempt of stuck) {
    result.examined += 1;
    try {
      const card = await cardFor(attempt.tenantId);
      const outcome = await reconcileUnknown({
        attemptId: attempt.id,
        provider: getProvider(card?.provider ?? "ICOUNT"),
        token: card?.token,
        clientId: card?.providerCustomerId ?? undefined,
      });

      if (outcome.state === "SUCCEEDED") result.resolvedPaid += 1;
      else if (outcome.state === "FAILED") result.resolvedUnpaid += 1;
      else result.escalated += 1;

      if (outcome.state === "MANUAL_REVIEW" && attempt.tenantId) {
        await emitBillingEvent({
          type: "payment.reconciliation_required",
          tenantId: attempt.tenantId,
          data: { attemptId: attempt.id, candidates: outcome.candidates },
        });
      }
    } catch (err) {
      // A failed lookup leaves the attempt exactly as it was. That is the point
      // - an unreachable provider must not become evidence of anything, in
      // either direction.
      console.warn("[billing] reconciliation lookup failed:", (err as Error)?.message);
      result.escalated += 1;
    }
  }

  return result;
}

/**
 * The card an attempt would have used.
 *
 * Decrypted only here and passed straight to the lookup. A token that cannot be
 * decrypted yields no card rather than a placeholder, so reconciliation reports
 * "could not check" instead of "no transaction found".
 */
async function cardFor(tenantId: string | null) {
  if (!tenantId) return null;
  const link = await prisma.billableEntityTenant.findUnique({ where: { tenantId } });
  if (!link) return null;
  const profile = await prisma.billingProfile.findFirst({
    where: { billableEntityId: link.billableEntityId },
    include: { paymentMethods: { where: { status: "ACTIVE" }, orderBy: { isDefault: "desc" }, take: 1 } },
  });
  const method = profile?.paymentMethods[0];
  if (!method) return null;
  try {
    return {
      provider: method.provider,
      token: decryptPaymentToken(method.token),
      providerCustomerId: profile?.providerCustomerId ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Everything a human needs to settle what the system would not.
 *
 * Returns no card token and no raw provider payload - whoever resolves this
 * needs to know which customer, how much, and when, not how to charge them
 * again.
 */
export async function pendingReconciliations(limit = 100) {
  const rows = await prisma.paymentAttempt.findMany({
    where: { state: { in: ["UNKNOWN", "RECONCILIATION_REQUIRED", "MANUAL_REVIEW"] } },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      tenantId: true,
      purpose: true,
      amount: true,
      currency: true,
      chargeAmount: true,
      chargeCurrency: true,
      state: true,
      failureCode: true,
      reviewReason: true,
      candidateCount: true,
      providerRequestStartedAt: true,
      reconciledAt: true,
      createdAt: true,
    },
  });

  const tenantIds = [...new Set(rows.map((r) => r.tenantId).filter(Boolean))] as string[];
  const tenants = await prisma.tenant.findMany({
    where: { id: { in: tenantIds } },
    select: { id: true, name: true },
  });
  const names = new Map(tenants.map((t) => [t.id, t.name]));

  return rows.map((r) => ({
    ...r,
    amount: String(r.amount),
    chargeAmount: r.chargeAmount == null ? null : String(r.chargeAmount),
    organizationName: r.tenantId ? (names.get(r.tenantId) ?? null) : null,
  }));
}
