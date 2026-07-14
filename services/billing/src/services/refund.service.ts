/**
 * Refunds & chargebacks. A refund (merchant-initiated) calls the provider then
 * reverses our state; a chargeback (bank-initiated, arrives via webhook) is
 * already final at the provider, so we only reverse our state + protect the
 * business (claw back purchased Units, suspend on dispute). Purchased-Unit
 * clawback reclaims whatever is still unspent - consumed Units can't be undone,
 * balance never goes negative.
 */
import { prisma, refundUnitsForReference } from "@chatcenter/shared";
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
export async function refundCharge(input: { chargeId: string; amount?: number; reason?: string }): Promise<{ ok: boolean; reclaimed: number; failureCode?: string }> {
  const charge = await prisma.charge.findUnique({ where: { id: input.chargeId }, include: { invoice: true } });
  if (!charge) return { ok: false, reclaimed: 0, failureCode: "charge_not_found" };
  if (charge.status !== "SUCCEEDED") return { ok: false, reclaimed: 0, failureCode: "charge_not_refundable" };

  const provider = getProvider(charge.provider);
  const res = await provider.refund({
    providerChargeRef: charge.providerChargeRef ?? "",
    amount: input.amount ?? Number(charge.amount),
    currency: charge.currency,
    reason: input.reason ?? "merchant_refund",
    idempotencyKey: `refund:${charge.id}`,
  });
  if (!res.success) return { ok: false, reclaimed: 0, failureCode: res.failureCode };
  return reverse({ chargeId: charge.id, kind: "refund", reason: input.reason ?? "merchant_refund" });
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
