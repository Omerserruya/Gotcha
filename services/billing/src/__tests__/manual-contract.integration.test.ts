/**
 * Manual external contract activation.
 *
 * The property under test throughout: a Sysadmin asserting money arrived must
 * activate the plan without ever claiming a provider transaction occurred, and
 * without escaping any rule a paid checkout obeys.
 */
import { describe, it, expect, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@chatcenter/shared";
import {
  activateManualContract,
  manualContractsForTenant,
  ManualContractRefused,
} from "../services/manual-contract.service";

const RUN = `mc-${Date.now()}`;
const tenantIds: string[] = [];

async function pendingTenant(opts: { amount?: number; currency?: string; status?: string } = {}) {
  const n = `${RUN}-${Math.random().toString(36).slice(2, 8)}`;
  const tenant = await prisma.tenant.create({
    data: { name: n, slug: n, status: (opts.status as any) ?? "PENDING_PAYMENT" },
  });
  tenantIds.push(tenant.id);
  const entity = await prisma.billableEntity.create({ data: { displayName: n } });
  await prisma.billableEntityTenant.create({ data: { billableEntityId: entity.id, tenantId: tenant.id } });
  const checkout = await prisma.pendingCheckout.create({
    data: {
      reference: `chk_${n}`,
      tenantId: tenant.id,
      planKey: "ai_workforce",
      planVersion: 1,
      snapshotPrice: opts.amount ?? 499,
      snapshotCurrency: opts.currency ?? "USD",
      snapshotIncludedCredits: 2000,
      amount: opts.amount ?? 499,
      currency: opts.currency ?? "USD",
      status: "PENDING",
      expiresAt: new Date(Date.now() + 3_600_000),
      idempotencyKey: `checkout:chk_${n}`,
    },
  });
  return { tenant, entityId: entity.id, checkout };
}

const VALID = {
  externalReference: "INV-2026-0042",
  paymentSourceDescription: "Bank transfer",
  reason: "Annual agreement settled by finance",
};

afterAll(async () => {
  const checkouts = await prisma.pendingCheckout.findMany({ where: { tenantId: { in: tenantIds } }, select: { id: true } });
  const ids = checkouts.map((c) => c.id);
  await prisma.paymentAttempt.deleteMany({ where: { checkoutId: { in: ids } } });
  await prisma.pendingCheckout.deleteMany({ where: { id: { in: ids } } });
  await prisma.aiUnitLot.deleteMany({ where: { tenantId: { in: tenantIds } } }).catch(() => {});
  await prisma.billableEntityTenant.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
});

describe("an externally settled contract activates the plan", () => {
  it("activates, sends the tenant to onboarding and grants credits once", async () => {
    const { tenant, entityId } = await pendingTenant();
    const res = await activateManualContract({
      tenantId: tenant.id, amount: 499, currency: "USD", ...VALID,
    });
    expect(res.firstActivation).toBe(true);

    const t = await prisma.tenant.findUnique({ where: { id: tenant.id } });
    // A contract settled by bank transfer buys the same thing a card does, and
    // leaves the organization with the same setup still to do.
    expect(t?.status).toBe("PENDING_ONBOARDING");

    const sub = await prisma.subscription.findUnique({ where: { billableEntityId: entityId } });
    expect(sub?.status).toBe("ACTIVE");
    // Reuses the one activation boundary, so the snapshot still governs.
    expect(Number(sub?.snapshotPrice)).toBe(499);

    const lots = await prisma.aiUnitLot.findMany({ where: { tenantId: tenant.id } });
    expect(lots.reduce((n, l) => n + Number(l.unitsGranted ?? 0), 0)).toBe(2000);
  });

  it("claims no provider transaction and creates no Charge", async () => {
    const { tenant } = await pendingTenant();
    await activateManualContract({ tenantId: tenant.id, amount: 499, currency: "USD", ...VALID });

    const attempt = await prisma.paymentAttempt.findFirst({ where: { tenantId: tenant.id } });
    expect(attempt?.paymentSource).toBe("MANUAL_EXTERNAL_CONTRACT");
    // The distinction that matters: no card, no provider, no fabricated ref.
    expect(attempt?.providerChargeRef).toBeNull();
    const link = await prisma.billableEntityTenant.findUnique({ where: { tenantId: tenant.id } });
    const invoices = await prisma.invoice.findMany({
      where: { billableEntityId: link!.billableEntityId }, select: { id: true },
    });
    expect(await prisma.charge.count({ where: { invoiceId: { in: invoices.map((i) => i.id) } } })).toBe(0);
  });

  it("records the provenance a support conversation would need", async () => {
    const { tenant } = await pendingTenant();
    await activateManualContract({ tenantId: tenant.id, amount: 499, currency: "USD", ...VALID });
    const [row] = await manualContractsForTenant(tenant.id);
    expect(row.externalReference).toBe("INV-2026-0042");
    expect(row.manualPaymentSource).toBe("Bank transfer");
    expect(row.manualReason).toMatch(/finance/);
    expect(row.consumedByActivationAt).toBeTruthy();
  });

  it("is idempotent - a double submit activates once", async () => {
    const { tenant } = await pendingTenant();
    const first = await activateManualContract({ tenantId: tenant.id, amount: 499, currency: "USD", ...VALID });
    const second = await activateManualContract({ tenantId: tenant.id, amount: 499, currency: "USD", ...VALID }).catch(
      (e) => ({ firstActivation: false, err: e.message }) as any,
    );
    expect(first.firstActivation).toBe(true);
    expect(second.firstActivation).toBe(false);

    const lots = await prisma.aiUnitLot.findMany({ where: { tenantId: tenant.id } });
    expect(lots.reduce((n, l) => n + Number(l.unitsGranted ?? 0), 0)).toBe(2000);
  });

  it("survives a concurrent double submit", async () => {
    const { tenant } = await pendingTenant();
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        activateManualContract({ tenantId: tenant.id, amount: 499, currency: "USD", ...VALID }).catch((e) => e),
      ),
    );
    expect(results.filter((r: any) => r?.firstActivation === true)).toHaveLength(1);
    const lots = await prisma.aiUnitLot.findMany({ where: { tenantId: tenant.id } });
    expect(lots.reduce((n, l) => n + Number(l.unitsGranted ?? 0), 0)).toBe(2000);
  });
});

describe("it refuses anything that would weaken the paid rules", () => {
  it("requires an external reference, a payment source and a reason", async () => {
    const { tenant } = await pendingTenant();
    for (const missing of ["externalReference", "paymentSourceDescription", "reason"] as const) {
      await expect(
        activateManualContract({
          tenantId: tenant.id, amount: 499, currency: "USD", ...VALID, [missing]: "  ",
        } as any),
      ).rejects.toThrow(/missing_required_field/);
    }
  });

  it("refuses an amount that does not match the snapshot", async () => {
    const { tenant } = await pendingTenant();
    // A different figure is a different commercial offer, not an override.
    await expect(
      activateManualContract({ tenantId: tenant.id, amount: 400, currency: "USD", ...VALID }),
    ).rejects.toThrow(/amount_does_not_match_snapshot/);
  });

  it("refuses a currency that does not match the snapshot", async () => {
    const { tenant } = await pendingTenant();
    await expect(
      activateManualContract({ tenantId: tenant.id, amount: 499, currency: "ILS", ...VALID }),
    ).rejects.toThrow(/currency_does_not_match_snapshot/);
  });

  it("refuses a tenant that is not awaiting payment", async () => {
    const { tenant } = await pendingTenant({ status: "ACTIVE" });
    await expect(
      activateManualContract({ tenantId: tenant.id, amount: 499, currency: "USD", ...VALID }),
    ).rejects.toThrow(/tenant_not_pending_payment/);
  });

  it("refuses to relabel an existing provider attempt as settled", async () => {
    const { tenant, checkout } = await pendingTenant();
    // A failed card payment must not become a manual contract by overwrite.
    await prisma.paymentAttempt.create({
      data: {
        attemptKey: `manual:${checkout.reference}`,
        checkoutId: checkout.id, tenantId: tenant.id,
        purpose: "SUBSCRIPTION_INITIAL", amount: 499, currency: "USD",
        state: "FAILED", paymentSource: "PROVIDER_CONFIRMED",
      },
    });
    await expect(
      activateManualContract({ tenantId: tenant.id, amount: 499, currency: "USD", ...VALID }),
    ).rejects.toThrow(/existing_attempt_is_not_manual/);
  });

  it("refuses when there is no checkout to activate", async () => {
    const n = `${RUN}-nochk`;
    const t = await prisma.tenant.create({ data: { name: n, slug: n, status: "PENDING_PAYMENT" } });
    tenantIds.push(t.id);
    // Without a checkout there is no snapshot, so activating would mean
    // inventing terms with nothing recording what was agreed.
    await expect(
      activateManualContract({ tenantId: t.id, amount: 499, currency: "USD", ...VALID }),
    ).rejects.toThrow(/no_resumable_checkout/);
  });

  it("refusals are typed", async () => {
    const { tenant } = await pendingTenant();
    await expect(
      activateManualContract({ tenantId: tenant.id, amount: 1, currency: "USD", ...VALID }),
    ).rejects.toBeInstanceOf(ManualContractRefused);
  });
});

describe("it reuses the single activation boundary", () => {
  const svc = readFileSync(join(__dirname, "../services/manual-contract.service.ts"), "utf8");

  it("does not create subscriptions or grant credits itself", () => {
    expect(svc).toContain("activatePaidCheckout");
    // One place creates subscriptions, so manual contracts cannot drift from
    // the rules a paid checkout obeys.
    expect(svc).not.toMatch(/prisma\.subscription\.(create|upsert)/);
    expect(svc).not.toContain("rolloverIncluded");
    expect(svc).not.toContain("materializeEntitlements");
  });

  it("calls no provider operation at all", () => {
    // Comments stripped: one explains that no cc/bill was called, and must not
    // trip the check it documents.
    const code = svc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    for (const op of ["cc/bill", "cc/transactions", "doc/cancel", "provider.charge", "icountProvider"]) {
      expect(code, `manual contract must not touch ${op}`).not.toContain(op);
    }
  });
});
