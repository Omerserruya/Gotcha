/**
 * Invoice + charge orchestration. Creates a thin Invoice record, runs an
 * idempotent charge through the provider, and (for iCount) records the legal
 * tax-document reference. The iCount-issued doc is the authoritative record;
 * our Invoice row is a mirror for in-app display + history.
 */
import { prisma, decryptPaymentToken } from "@chatcenter/shared";
import type { BillingProvider, InvoiceType } from "@prisma/client";
import { getProvider } from "../providers";
import { emitBillingEvent } from "../lib/events";

export interface ChargeForInput {
  entityId: string;
  tenantId: string;
  type: InvoiceType;
  amount: number;
  currency?: string;
  description: string;
  /** Stable key so retries never double-charge. */
  idempotencyKey: string;
  attemptNumber?: number;
}

export interface ChargeForResult {
  success: boolean;
  invoiceId: string;
  failureCode?: string;
}

/** Resolve the entity's payment context (provider + default token + profile). */
async function paymentContext(entityId: string): Promise<{
  provider: BillingProvider;
  token?: string;
  providerCustomerId?: string;
  currency: string;
  customer: { email?: string; vatId?: string };
} | null> {
  const profile = await prisma.billingProfile.findUnique({
    where: { billableEntityId: entityId },
    include: { paymentMethods: { where: { status: "ACTIVE" }, orderBy: { isDefault: "desc" } } },
  });
  if (!profile) return null;
  const pm = profile.paymentMethods[0];
  return {
    provider: profile.provider,
    token: pm?.token,
    providerCustomerId: profile.providerCustomerId ?? undefined,
    currency: profile.currency,
    customer: { email: profile.billingEmail ?? undefined, vatId: profile.vatId ?? undefined },
  };
}

/**
 * Charge the entity's default payment method for `amount`, recording an Invoice
 * + Charge and (on success) the iCount tax-doc reference. Idempotent on
 * `idempotencyKey` (a duplicate returns the prior Charge's outcome).
 */
export async function chargeFor(input: ChargeForInput): Promise<ChargeForResult> {
  const ctx = await paymentContext(input.entityId);
  const currency = input.currency || ctx?.currency || "ILS";

  // Atomically CLAIM the idempotency key BEFORE touching the provider. We create
  // the Invoice + a PENDING Charge in one transaction; the Charge's UNIQUE
  // idempotencyKey is the concurrency guard. If a sibling request already
  // claimed it, the create throws P2002, the whole tx rolls back (no orphan
  // invoice), and we return the existing charge's outcome - so the provider is
  // hit AT MOST ONCE per key even under concurrent calls / retries.
  let invoiceId: string;
  let chargeId: string;
  try {
    const claim = await prisma.$transaction(async (tx) => {
      const inv = await tx.invoice.create({
        data: {
          billableEntityId: input.entityId,
          provider: ctx?.provider ?? "ICOUNT",
          type: input.type,
          amount: input.amount.toFixed(2),
          currency,
          status: "DRAFT",
          lineItems: [{ description: input.description, amount: input.amount }],
        },
      });
      const chg = await tx.charge.create({
        data: { invoiceId: inv.id, provider: ctx?.provider ?? "ICOUNT", amount: input.amount.toFixed(2), currency, status: "PENDING", attemptNumber: input.attemptNumber ?? 1, idempotencyKey: input.idempotencyKey },
      });
      return { invoiceId: inv.id, chargeId: chg.id };
    });
    invoiceId = claim.invoiceId;
    chargeId = claim.chargeId;
  } catch (err: any) {
    if (err?.code === "P2002") {
      const prior = await prisma.charge.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (prior) {
        const inProgress = prior.status === "PENDING";
        return { success: prior.status === "SUCCEEDED", invoiceId: prior.invoiceId, failureCode: prior.failureCode ?? (inProgress ? "charge_in_progress" : undefined) };
      }
    }
    throw err;
  }
  const invoice = { id: invoiceId };

  if (!ctx?.token) {
    await prisma.charge.update({
      where: { id: chargeId },
      data: { status: "FAILED", failureCode: "no_payment_method" },
    });
    await prisma.invoice.update({ where: { id: invoice.id }, data: { status: "FAILED" } });
    await emitBillingEvent({ type: "payment.failed", tenantId: input.tenantId, data: { invoiceId: invoice.id, reason: "no_payment_method", amount: input.amount } });
    return { success: false, invoiceId: invoice.id, failureCode: "no_payment_method" };
  }

  const provider = getProvider(ctx.provider);
  const result = await provider.charge({
    // Decrypted at the last possible moment, immediately before the provider
    // call, and never held anywhere a DTO, log or audit event can reach.
    // A token that cannot be decrypted fails the charge loudly rather than
    // being silently replaced or dropped.
    token: decryptPaymentToken(ctx.token),
    providerCustomerId: ctx.providerCustomerId,
    amount: input.amount,
    currency,
    description: input.description,
    idempotencyKey: input.idempotencyKey,
    issueInvoice: true,
    customer: ctx.customer,
  });

  await prisma.charge.update({
    where: { id: chargeId },
    data: {
      providerChargeRef: result.providerChargeRef,
      status: result.success ? "SUCCEEDED" : "FAILED",
      failureCode: result.failureCode,
    },
  });

  if (result.success) {
    await prisma.invoice.update({
      where: { id: invoice.id },
      data: { status: "PAID", issuedAt: new Date(), paidAt: new Date(), providerInvoiceRef: result.providerInvoiceRef, providerPdfUrl: result.providerPdfUrl },
    });
    await emitBillingEvent({ type: "invoice.paid", tenantId: input.tenantId, data: { invoiceId: invoice.id, amount: input.amount, providerInvoiceRef: result.providerInvoiceRef } });
    return { success: true, invoiceId: invoice.id };
  }

  await prisma.invoice.update({ where: { id: invoice.id }, data: { status: "FAILED" } });
  await emitBillingEvent({ type: "payment.failed", tenantId: input.tenantId, data: { invoiceId: invoice.id, reason: result.failureCode, amount: input.amount } });
  return { success: false, invoiceId: invoice.id, failureCode: result.failureCode };
}
