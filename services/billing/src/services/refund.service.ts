/**
 * Refunds & chargebacks. A refund (merchant-initiated) calls the provider then
 * reverses our state; a chargeback (bank-initiated, arrives via webhook) is
 * already final at the provider, so we only reverse our state + protect the
 * business (claw back purchased Units, suspend on dispute). Purchased-Unit
 * clawback reclaims whatever is still unspent - consumed Units can't be undone,
 * balance never goes negative.
 */
import { prisma, refundUnitsForReference, writeAudit, AuditAction } from "@chatcenter/shared";
import { getProvider } from "../providers";
import { tenantsForEntity } from "./billable-entity.service";
import { suspendTenants } from "./tenant-status.service";
import { emitBillingEvent } from "../lib/events";

async function tenantForInvoice(invoice: { billableEntityId: string }): Promise<string | undefined> {
  return (await tenantsForEntity(invoice.billableEntityId))[0];
}

/** Reverse our state for a charge that was refunded or charged back. */
async function reverse(opts: {
  chargeId: string;
  kind: "refund" | "chargeback";
  reason: string;
}): Promise<{ ok: boolean; reclaimed: number }> {
  const charge = await prisma.charge.findUnique({ where: { id: opts.chargeId }, include: { invoice: true } });
  if (!charge) return { ok: false, reclaimed: 0 };
  const invoice = charge.invoice;
  const tenantId = await tenantForInvoice(invoice);

  await prisma.charge.update({ where: { id: charge.id }, data: { status: "REFUNDED" } });
  await prisma.invoice.update({ where: { id: invoice.id }, data: { status: "VOID" } });

  // Claw back purchased Units bought with this invoice (CREDIT_PURCHASE/AUTO).
  let reclaimed = 0;
  if (tenantId && (invoice.type === "CREDIT_PURCHASE" || invoice.type === "AUTO_PURCHASE")) {
    ({ reclaimed } = await refundUnitsForReference(tenantId, invoice.id, `${opts.kind}:${opts.reason}`));
  }

  // A chargeback is an adversarial signal - suspend the subscription so the AI
  // gate refuses service until the dispute is resolved / a new card is added.
  if (opts.kind === "chargeback") {
    const sub = await prisma.subscription.findUnique({ where: { billableEntityId: invoice.billableEntityId } });
    if (sub && sub.status !== "SUSPENDED" && sub.status !== "CANCELED") {
      await prisma.subscription.update({ where: { id: sub.id }, data: { status: "SUSPENDED" } });
      await suspendTenants(invoice.billableEntityId);
      await prisma.subscriptionEvent.create({ data: { subscriptionId: sub.id, type: "suspended", fromStatus: sub.status, toStatus: "SUSPENDED", actor: "chargeback", metadata: { reason: opts.reason } as any } });
    }
  }

  if (tenantId) {
    await emitBillingEvent({
      type: opts.kind === "chargeback" ? "subscription.suspended" : "payment.failed",
      tenantId,
      data: { invoiceId: invoice.id, kind: opts.kind, reason: opts.reason, unitsReclaimed: reclaimed },
    });
  }
  return { ok: true, reclaimed };
}

/** Merchant-initiated refund: call the provider, then reverse our state. */
export async function refundCharge(input: {
  chargeId: string;
  amount?: number;
  reason?: string;
  /** Who asked for this. Recorded in the audit trail. */
  actor?: string | null;
}): Promise<{ ok: boolean; reclaimed: number; failureCode?: string }> {
  const charge = await prisma.charge.findUnique({ where: { id: input.chargeId }, include: { invoice: true } });
  if (!charge) return { ok: false, reclaimed: 0, failureCode: "charge_not_found" };

  const tenantId = charge.invoice ? await tenantForInvoice(charge.invoice) : undefined;

  if (charge.status !== "SUCCEEDED") {
    // UNKNOWN lands here too, and should: refunding a charge we cannot confirm
    // happened could return money that was never taken. Reconcile first.
    await audit(tenantId, AuditAction.REFUND_REFUSED, charge, input.actor, {
      reason: "charge_not_refundable",
      chargeStatus: charge.status,
    });
    return { ok: false, reclaimed: 0, failureCode: "charge_not_refundable" };
  }

  // Refund what was actually TAKEN. The charge moved shekels; the invoice was
  // agreed in dollars, and sending the dollar figure to a refund would describe
  // the wrong amount everywhere it is recorded.
  const settledAmount = charge.chargeAmount != null ? Number(charge.chargeAmount) : Number(charge.amount);
  const settledCurrency = charge.chargeCurrency ?? charge.currency;

  const provider = getProvider(charge.provider);
  const res = await provider.refund({
    providerChargeRef: charge.providerChargeRef ?? "",
    amount: input.amount ?? settledAmount,
    currency: settledCurrency,
    reason: input.reason ?? "merchant_refund",
    idempotencyKey: `refund:${charge.id}`,
    // iCount cancels a DOCUMENT, not a charge, so the issued document
    // reference is what the refund actually needs. Passing the full settled
    // amount lets the provider refuse a partial refund it cannot honour
    // instead of silently returning the whole thing.
    providerInvoiceRef: charge.invoice?.providerInvoiceRef ?? undefined,
    expectedFullAmount: settledAmount,
  });

  if (!res.success) {
    await audit(tenantId, AuditAction.REFUND_REFUSED, charge, input.actor, {
      reason: res.failureCode ?? "provider_refused",
    });
    return { ok: false, reclaimed: 0, failureCode: res.failureCode };
  }

  const reversed = await reverse({ chargeId: charge.id, kind: "refund", reason: input.reason ?? "merchant_refund" });
  await audit(tenantId, AuditAction.REFUND_ISSUED, charge, input.actor, {
    reason: input.reason ?? "merchant_refund",
    unitsReclaimed: reversed.reclaimed,
  });
  return reversed;
}

/**
 * Record a refund decision.
 *
 * Both outcomes are audited, not just the successful one. A refund that was
 * attempted and refused is exactly what someone reconstructs afterwards when a
 * customer says they were promised their money back.
 */
async function audit(
  tenantId: string | undefined,
  action: string,
  charge: { id: string; amount: unknown; currency: string; chargeAmount: unknown; chargeCurrency: string | null; invoiceId: string },
  actor: string | null | undefined,
  metadata: Record<string, unknown>,
): Promise<void> {
  await writeAudit({
    tenantId: tenantId ?? "platform",
    actorType: actor ? "user" : "system",
    actorId: actor ?? null,
    action,
    targetType: "charge",
    targetId: charge.id,
    metadata: {
      invoiceId: charge.invoiceId,
      agreed: `${String(charge.amount)} ${charge.currency}`,
      // What actually leaves or returns to the customer's card.
      settled: charge.chargeAmount == null ? null : `${String(charge.chargeAmount)} ${charge.chargeCurrency ?? ""}`.trim(),
      ...metadata,
    },
  });
}

/** Bank-initiated chargeback (from a provider webhook): reverse state only. */
export async function applyChargeback(input: { providerChargeRef: string; reason?: string }): Promise<{ ok: boolean; reclaimed: number }> {
  const charge = await prisma.charge.findFirst({ where: { providerChargeRef: input.providerChargeRef } });
  if (!charge) return { ok: false, reclaimed: 0 };
  return reverse({ chargeId: charge.id, kind: "chargeback", reason: input.reason ?? "chargeback" });
}

/** Refund-confirmation webhook (provider already refunded): reverse state only. */
export async function applyRefundConfirmation(input: { providerChargeRef: string; reason?: string }): Promise<{ ok: boolean; reclaimed: number }> {
  const charge = await prisma.charge.findFirst({ where: { providerChargeRef: input.providerChargeRef } });
  if (!charge || charge.status === "REFUNDED") return { ok: false, reclaimed: 0 };
  return reverse({ chargeId: charge.id, kind: "refund", reason: input.reason ?? "provider_refund" });
}
