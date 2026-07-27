/**
 * Refunds under dual currency.
 *
 * The property under test: a refund returns what was actually TAKEN. The
 * invoice was agreed in dollars and the card was debited in shekels, so a
 * refund described in dollars would be the wrong number everywhere it is
 * recorded - the audit entry, the provider request, and whatever a support
 * agent reads back to the customer.
 *
 * And: both outcomes are audited. A refund attempted and refused is exactly
 * what someone reconstructs when a customer says they were promised their money
 * back.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "@chatcenter/shared";

process.env.BILLING_PAYMENT_TOKEN_ENCRYPTION_KEY =
  process.env.BILLING_PAYMENT_TOKEN_ENCRYPTION_KEY || Buffer.alloc(32, 3).toString("base64");

import { refundCharge } from "../services/refund.service";

const RUN = `rf-${Date.now()}`;
const tenantIds: string[] = [];
const entityIds: string[] = [];
const ORIGINAL = { ...process.env };

async function chargedTenant(opts: { status?: any; withSettled?: boolean } = {}) {
  const n = `${RUN}-${Math.random().toString(36).slice(2, 8)}`;
  const tenant = await prisma.tenant.create({ data: { name: n, slug: n, status: "ACTIVE" } });
  const entity = await prisma.billableEntity.create({ data: { displayName: n } });
  await prisma.billableEntityTenant.create({ data: { billableEntityId: entity.id, tenantId: tenant.id } });
  tenantIds.push(tenant.id);
  entityIds.push(entity.id);

  const invoice = await prisma.invoice.create({
    data: {
      billableEntityId: entity.id,
      provider: "ICOUNT",
      type: "SUBSCRIPTION",
      amount: "499.00",
      currency: "USD",
      status: "PAID",
      providerInvoiceRef: "doc_1",
      lineItems: [{ description: "plan", amount: 499 }] as any,
    },
  });

  const withSettled = opts.withSettled !== false;
  const charge = await prisma.charge.create({
    data: {
      invoiceId: invoice.id,
      provider: "ICOUNT",
      providerChargeRef: "conf_1",
      amount: "499.00",
      currency: "USD",
      chargeAmount: withSettled ? "1821.35" : null,
      chargeCurrency: withSettled ? "ILS" : null,
      providerCurrencyId: withSettled ? 1 : null,
      fxRate: withSettled ? "3.65" : null,
      fxRateVersion: withSettled ? 1 : null,
      status: opts.status ?? "SUCCEEDED",
      idempotencyKey: `${RUN}-${Math.random().toString(36).slice(2, 10)}`,
    },
  });

  return { tenant, entityId: entity.id, invoice, charge };
}

async function auditFor(tenantId: string) {
  return prisma.auditLog.findMany({
    where: { tenantId, action: { startsWith: "billing.refund_" } },
    orderBy: { createdAt: "desc" },
  });
}

beforeEach(() => {
  // Mock refunds succeed without a network call.
  process.env.ICOUNT_MODE = "mock";
  delete process.env.ICOUNT_ALLOW_LIVE;
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { tenantId: { in: tenantIds } } });
  const invoices = await prisma.invoice.findMany({
    where: { billableEntityId: { in: entityIds } }, select: { id: true },
  });
  await prisma.charge.deleteMany({ where: { invoiceId: { in: invoices.map((i) => i.id) } } });
  await prisma.invoice.deleteMany({ where: { billableEntityId: { in: entityIds } } });
  await prisma.billableEntityTenant.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  process.env = { ...ORIGINAL };
});

describe("a refund returns what was taken", () => {
  it("reverses the charge and voids the invoice", async () => {
    const { charge, invoice } = await chargedTenant();
    const res = await refundCharge({ chargeId: charge.id, reason: "customer_request", actor: "u_1" });
    expect(res.ok).toBe(true);

    const after = await prisma.charge.findUnique({ where: { id: charge.id } });
    expect(after!.status).toBe("REFUNDED");
    const inv = await prisma.invoice.findUnique({ where: { id: invoice.id } });
    expect(inv!.status).toBe("VOID");
  });

  it("records both figures, so the shekel amount is recoverable", async () => {
    const { tenant, charge } = await chargedTenant();
    await refundCharge({ chargeId: charge.id, actor: "u_1" });

    const [entry] = await auditFor(tenant.id);
    expect(entry.action).toBe("billing.refund_issued");
    const meta = entry.metadata as any;
    expect(meta.agreed).toBe("499 USD");
    // The number that actually returns to the card.
    expect(meta.settled).toBe("1821.35 ILS");
    expect(entry.actorId).toBe("u_1");
  });

  it("refuses a charge whose outcome was never confirmed", async () => {
    const { tenant, charge } = await chargedTenant({ status: "UNKNOWN" });
    const res = await refundCharge({ chargeId: charge.id, actor: "u_1" });
    // Refunding a charge we cannot confirm happened could return money that was
    // never taken. Reconcile first.
    expect(res.ok).toBe(false);
    expect(res.failureCode).toBe("charge_not_refundable");

    const [entry] = await auditFor(tenant.id);
    // The refusal is audited too - that is what someone reconstructs when a
    // customer says they were promised their money back.
    expect(entry.action).toBe("billing.refund_refused");
    expect((entry.metadata as any).chargeStatus).toBe("UNKNOWN");
  });

  it("refuses to refund the same charge twice", async () => {
    const { charge } = await chargedTenant();
    expect((await refundCharge({ chargeId: charge.id })).ok).toBe(true);
    // The second attempt sees a REFUNDED charge, not a SUCCEEDED one.
    expect((await refundCharge({ chargeId: charge.id })).ok).toBe(false);
  });

  it("falls back to the agreed figure for a charge predating dual currency", async () => {
    const { tenant, charge } = await chargedTenant({ withSettled: false });
    const res = await refundCharge({ chargeId: charge.id, actor: "u_1" });
    expect(res.ok).toBe(true);
    const [entry] = await auditFor(tenant.id);
    // Older rows have no settled amount. Recording null is honest; inventing a
    // conversion after the fact would not be.
    expect((entry.metadata as any).settled).toBeNull();
  });

  it("names a person when one asked, and the system when none did", async () => {
    const a = await chargedTenant();
    await refundCharge({ chargeId: a.charge.id, actor: "u_9" });
    expect((await auditFor(a.tenant.id))[0].actorType).toBe("user");

    const b = await chargedTenant();
    await refundCharge({ chargeId: b.charge.id });
    expect((await auditFor(b.tenant.id))[0].actorType).toBe("system");
  });
});
