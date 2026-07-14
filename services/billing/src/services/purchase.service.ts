/**
 * AI-Unit purchases - manual and automatic. Purchased Units are PURCHASED-bucket
 * lots (never expire, FIFO after included). Auto-purchase respects an enabled
 * flag + a monthly spend ceiling; hitting the ceiling notifies + offers a manual
 * purchase path rather than silently stopping.
 */
import { prisma, grantUnits } from "@chatcenter/shared";
import { getEntityIdForTenant } from "./billable-entity.service";
import { chargeFor } from "./invoice.service";
import { emitBillingEvent } from "../lib/events";
import { periodKeyFor } from "../lib/period";

export interface PurchaseResult {
  success: boolean;
  units?: number;
  invoiceId?: string;
  failureCode?: string;
}

async function getPackage(key: string) {
  return prisma.creditPackage.findUnique({ where: { key } });
}

/** Manual credit purchase (customer-initiated). */
export async function buyCredits(input: { tenantId: string; packageKey: string; actor?: string }): Promise<PurchaseResult> {
  const entityId = await getEntityIdForTenant(input.tenantId);
  if (!entityId) return { success: false, failureCode: "no_billable_entity" };
  const pkg = await getPackage(input.packageKey);
  if (!pkg || !pkg.active) return { success: false, failureCode: "unknown_package" };

  const idempotencyKey = `buy:${entityId}:${input.packageKey}:${Date.now()}`;
  const res = await chargeFor({
    entityId,
    tenantId: input.tenantId,
    type: "CREDIT_PURCHASE",
    amount: Number(pkg.price),
    currency: pkg.currency,
    description: `${pkg.name} (AI Units)`,
    idempotencyKey,
  });
  if (!res.success) return { success: false, invoiceId: res.invoiceId, failureCode: res.failureCode };

  await grantUnits({ tenantId: input.tenantId, bucket: "PURCHASED", grantType: "PURCHASE", units: pkg.units, source: `package:${pkg.key}`, referenceId: res.invoiceId });
  return { success: true, units: pkg.units, invoiceId: res.invoiceId };
}

/**
 * Auto-purchase triggered when AI-Unit balance crosses the policy threshold.
 * Idempotency + ceiling enforcement keep it safe and deterministic.
 */
export async function triggerAutoPurchase(input: { tenantId: string; reason?: string }): Promise<PurchaseResult> {
  const entityId = await getEntityIdForTenant(input.tenantId);
  if (!entityId) return { success: false, failureCode: "no_billable_entity" };
  const policy = await prisma.autoPurchasePolicy.findUnique({ where: { billableEntityId: entityId } });
  if (!policy || !policy.enabled || !policy.packageKey) return { success: false, failureCode: "auto_purchase_disabled" };
  const pkg = await getPackage(policy.packageKey);
  if (!pkg || !pkg.active) return { success: false, failureCode: "unknown_package" };

  const monthKey = periodKeyFor(new Date());
  // Reset the spend window when the month rolls over.
  const spentThisMonth = policy.monthSpendKey === monthKey ? Number(policy.monthSpentAmount) : 0;
  const price = Number(pkg.price);
  const ceiling = policy.maxMonthlySpend != null ? Number(policy.maxMonthlySpend) : Infinity;

  if (spentThisMonth + price > ceiling) {
    await emitBillingEvent({ type: "credit.auto_purchase_ceiling_reached", tenantId: input.tenantId, data: { packageKey: pkg.key, price, spentThisMonth, ceiling, manualPurchasePath: "/settings/billing/credits" } });
    return { success: false, failureCode: "monthly_ceiling_reached" };
  }

  const idempotencyKey = `auto:${entityId}:${monthKey}:${pkg.key}:${Math.floor(Date.now() / 60000)}`;
  const res = await chargeFor({
    entityId,
    tenantId: input.tenantId,
    type: "AUTO_PURCHASE",
    amount: price,
    currency: pkg.currency,
    description: `Auto-purchase: ${pkg.name}`,
    idempotencyKey,
  });

  if (!res.success) {
    await emitBillingEvent({ type: "credit.auto_purchase_failed", tenantId: input.tenantId, data: { packageKey: pkg.key, reason: res.failureCode } });
    return { success: false, invoiceId: res.invoiceId, failureCode: res.failureCode };
  }

  await grantUnits({ tenantId: input.tenantId, bucket: "PURCHASED", grantType: "AUTO", units: pkg.units, source: `auto:${pkg.key}`, referenceId: res.invoiceId });
  await prisma.autoPurchasePolicy.update({
    where: { billableEntityId: entityId },
    data: { monthSpendKey: monthKey, monthSpentAmount: (spentThisMonth + price).toFixed(2), lastTriggeredAt: new Date() },
  });
  await emitBillingEvent({ type: "credit.auto_purchase_succeeded", tenantId: input.tenantId, data: { packageKey: pkg.key, units: pkg.units, price, invoiceId: res.invoiceId } });
  return { success: true, units: pkg.units, invoiceId: res.invoiceId };
}
