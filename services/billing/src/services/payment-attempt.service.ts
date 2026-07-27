/**
 * Payment attempts: the double-charge guard.
 *
 * iCount has confirmed no provider-side idempotency mechanism, so nothing on
 * their end will reject a duplicate `cc/bill`. GOTCHA's own uniqueness is the
 * only thing standing between a retry and a second charge, which makes this
 * file load-bearing rather than bookkeeping.
 *
 * The rules, in order of importance:
 *
 *   1. One row per LOGICAL charge, keyed by `attemptKey`. Creating a second is
 *      a database conflict, not a second call to the provider.
 *   2. A charge whose outcome is unknown (timeout, crash between request and
 *      response) becomes UNKNOWN - never FAILED. FAILED means "the provider
 *      told us no"; UNKNOWN means "we do not know", and treating the second as
 *      the first is how you charge someone twice.
 *   3. UNKNOWN is NEVER automatically retried. It must be reconciled against
 *      the provider first.
 *   4. Reconciliation that cannot decide - several equally plausible candidate
 *      transactions - becomes MANUAL_REVIEW. A human decides; the system does
 *      not guess with someone's money.
 */
import { prisma } from "@chatcenter/shared";
import type { PaymentAttemptState } from "@prisma/client";
import type { ChargeInput, ChargeResult, PaymentProvider } from "../providers/provider";
import { assertChargeCurrency, type ProviderCapabilities } from "../providers/capabilities";

export type AttemptPurpose =
  | "SUBSCRIPTION_INITIAL"
  | "RENEWAL"
  | "CREDIT_PURCHASE"
  | "AUTO_TOPUP";

export interface BeginAttemptInput {
  attemptKey: string;
  purpose: AttemptPurpose;
  amount: number;
  currency: string;
  tenantId?: string | null;
  checkoutId?: string | null;
}

export interface AttemptRecord {
  id: string;
  attemptKey: string;
  state: PaymentAttemptState;
  providerChargeRef: string | null;
  failureCode: string | null;
}

/** Errors that mean "we do not know what happened", as opposed to a decline. */
function isAmbiguousFailure(err: unknown): boolean {
  const e = err as any;
  const code = String(e?.code ?? "");
  const msg = String(e?.message ?? "");
  return (
    code === "ECONNABORTED" || // axios timeout
    code === "ETIMEDOUT" ||
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    /timeout|timed out|socket hang up|network/i.test(msg)
  );
}

/**
 * Claim the right to make exactly one charge.
 *
 * Returns `{ created: false }` when this logical charge has already been
 * attempted - the caller must NOT charge again, whatever the existing state
 * says. An already-existing UNKNOWN in particular is a reason to reconcile, not
 * a reason to try once more.
 */
export async function beginAttempt(
  input: BeginAttemptInput,
): Promise<{ created: boolean; attempt: AttemptRecord }> {
  try {
    const attempt = await prisma.paymentAttempt.create({
      data: {
        attemptKey: input.attemptKey,
        purpose: input.purpose,
        amount: input.amount,
        currency: input.currency,
        tenantId: input.tenantId ?? null,
        checkoutId: input.checkoutId ?? null,
        state: "PENDING",
      },
      select: { id: true, attemptKey: true, state: true, providerChargeRef: true, failureCode: true },
    });
    return { created: true, attempt };
  } catch (err: any) {
    // P2002 = unique violation on attemptKey. Someone already claimed this
    // charge; surfacing the existing row is the whole point of the constraint.
    if (err?.code !== "P2002") throw err;
    const existing = await prisma.paymentAttempt.findUnique({
      where: { attemptKey: input.attemptKey },
      select: { id: true, attemptKey: true, state: true, providerChargeRef: true, failureCode: true },
    });
    if (!existing) throw err; // vanished between insert and read - genuinely exceptional
    return { created: false, attempt: existing };
  }
}

/**
 * Execute a claimed attempt exactly once.
 *
 * Never called for an attempt that already exists in any state: `beginAttempt`
 * decides that, and this function assumes the claim was fresh.
 */
export async function runAttempt(args: {
  attemptId: string;
  provider: PaymentProvider;
  capabilities: ProviderCapabilities;
  charge: ChargeInput;
}): Promise<{ state: PaymentAttemptState; result?: ChargeResult }> {
  // Refuse before any network call if the currency contract is unverified for
  // this currency - a USD snapshot must never be submitted and settle as ILS.
  try {
    assertChargeCurrency(args.capabilities, args.charge.currency);
  } catch (err: any) {
    await setState(args.attemptId, "FAILED", { failureCode: err.message });
    return { state: "FAILED" };
  }

  let result: ChargeResult;
  try {
    result = await args.provider.charge(args.charge);
  } catch (err) {
    if (isAmbiguousFailure(err)) {
      // We may or may not have charged. Do not guess, do not retry.
      await setState(args.attemptId, "UNKNOWN", {
        failureCode: "ambiguous_outcome: provider did not answer",
      });
      return { state: "UNKNOWN" };
    }
    await setState(args.attemptId, "FAILED", {
      failureCode: (err as any)?.message ?? "charge_failed",
    });
    return { state: "FAILED" };
  }

  if (result.success) {
    await setState(args.attemptId, "SUCCEEDED", { providerChargeRef: result.providerChargeRef });
    return { state: "SUCCEEDED", result };
  }
  await setState(args.attemptId, "FAILED", { failureCode: result.failureCode });
  return { state: "FAILED", result };
}

/**
 * Resolve an UNKNOWN attempt by asking the provider what actually happened.
 *
 * Outcomes:
 *   exactly one matching transaction  -> SUCCEEDED, reference recorded
 *   no matching transaction           -> FAILED, safe to charge again
 *   more than one equal candidate     -> MANUAL_REVIEW, a human decides
 *
 * Deliberately conservative: without a merchant reference on the transaction
 * (iCount confirms none), matching is by amount and card token, which cannot
 * distinguish two identical legitimate charges. That ambiguity is escalated
 * rather than resolved by picking one.
 */
export async function reconcileUnknown(args: {
  attemptId: string;
  provider: PaymentProvider;
  token?: string;
  clientId?: string;
}): Promise<{ state: PaymentAttemptState; candidates: number }> {
  const attempt = await prisma.paymentAttempt.findUnique({ where: { id: args.attemptId } });
  if (!attempt) throw new Error("attempt_not_found");
  if (attempt.state !== "UNKNOWN") {
    return { state: attempt.state, candidates: attempt.candidateCount ?? 0 };
  }

  if (!args.provider.lookupTransactions) {
    // No lookup capability: we can never learn the truth automatically.
    await setState(args.attemptId, "MANUAL_REVIEW", {
      reviewReason: "provider has no transaction lookup",
      reconciledAt: new Date(),
    });
    return { state: "MANUAL_REVIEW", candidates: 0 };
  }

  const raw: any = await args.provider.lookupTransactions({
    token: args.token,
    clientId: args.clientId,
  });
  const all: any[] = Array.isArray(raw?.transactions)
    ? raw.transactions
    : Array.isArray(raw)
      ? raw
      : [];

  const wanted = Number(attempt.amount);
  const candidates = all.filter((t) => Number(t?.sum ?? t?.amount) === wanted);

  if (candidates.length === 1) {
    const t = candidates[0];
    await setState(args.attemptId, "SUCCEEDED", {
      providerChargeRef: t?.confirmation_code || t?.deal_id || t?.txn_id || null,
      candidateCount: 1,
      reconciledAt: new Date(),
    });
    return { state: "SUCCEEDED", candidates: 1 };
  }

  if (candidates.length === 0) {
    await setState(args.attemptId, "FAILED", {
      failureCode: "reconciled: no matching transaction at the provider",
      candidateCount: 0,
      reconciledAt: new Date(),
    });
    return { state: "FAILED", candidates: 0 };
  }

  await setState(args.attemptId, "MANUAL_REVIEW", {
    reviewReason: `ambiguous: ${candidates.length} transactions match this amount`,
    candidateCount: candidates.length,
    reconciledAt: new Date(),
  });
  return { state: "MANUAL_REVIEW", candidates: candidates.length };
}

/**
 * Whether a purpose may be attempted again.
 *
 * UNKNOWN and MANUAL_REVIEW are terminal for automation: both mean a charge
 * might already exist. Only an outcome the provider explicitly refused is
 * safe to repeat.
 */
export function mayRetry(state: PaymentAttemptState): boolean {
  return state === "FAILED";
}

async function setState(
  id: string,
  state: PaymentAttemptState,
  extra: {
    providerChargeRef?: string | null;
    failureCode?: string | null;
    reviewReason?: string;
    candidateCount?: number;
    reconciledAt?: Date;
  } = {},
): Promise<void> {
  await prisma.paymentAttempt.update({ where: { id }, data: { state, ...extra } });
}
