/**
 * DB-backed integration tests for the canonical credit contract
 * (GET /api/billing/credit-summary) and the wallet underneath it.
 *
 * Runs against the REAL dev postgres (docker `db` exposed on localhost:5432).
 * All rows are uniquely prefixed (itest_*) and deleted in afterAll - no
 * mocked ledger, no synthetic balances: every number asserted here went
 * through the actual Prisma models the product uses.
 *
 * Auth middlewares are replaced with pass-throughs that inject the test
 * principal (authorization itself is covered by the permission unit tests);
 * everything below the middleware line - routes, services, wallet, DB - is
 * the real thing.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";

// Must be set BEFORE @chatcenter/shared instantiates its Prisma client.
const ctx = vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/whatsapp_cc";
  process.env.ICOUNT_MODE = "mock";
  return { tenantId: "", userId: "itest-user" };
});

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@chatcenter/shared")>();
  return {
    ...actual,
    authenticate: (req: any, _res: any, next: any) => {
      req.user = { userId: ctx.userId, tenantId: ctx.tenantId, role: "ADMIN", email: "itest@example.com" };
      next();
    },
    resolveTenant: (req: any, _res: any, next: any) => {
      req.tenantId = ctx.tenantId;
      next();
    },
    requirePermission: () => (_req: any, _res: any, next: any) => next(),
  };
});

import { prisma, grantUnits, consumeUnits, getBalance, refundUnitsForReference } from "@chatcenter/shared";
import creditsRoutes from "../routes/credits";
import { periodKeyFor } from "../lib/period";

const RUN = `itest_${Date.now()}`;
const PLAN_KEY = `${RUN}_plan`;
const PLAN2_KEY = `${RUN}_plan2`;

const app = express();
app.use(express.json());
app.use("/api", creditsRoutes);

let tenantA = "";
let tenantB = "";
let entityA = "";
const periodStart = new Date();
const periodEnd = new Date(Date.now() + 30 * 86_400_000);
const periodKey = periodKeyFor(periodStart);

async function mkTenant(suffix: string): Promise<{ tenantId: string; entityId: string }> {
  const t = await prisma.tenant.create({ data: { name: `${RUN}-${suffix}`, slug: `${RUN}-${suffix}`, status: "ACTIVE" } });
  const e = await prisma.billableEntity.create({ data: { displayName: `${RUN}-${suffix}` } });
  await prisma.billableEntityTenant.create({ data: { billableEntityId: e.id, tenantId: t.id } });
  return { tenantId: t.id, entityId: e.id };
}

beforeAll(async () => {
  const a = await mkTenant("a");
  const b = await mkTenant("b");
  tenantA = a.tenantId; entityA = a.entityId;
  tenantB = b.tenantId;

  await prisma.plan.create({ data: { key: PLAN_KEY, name: "ITest Plan", basePrice: "100.00", includedAiUnits: 1000, active: true } });
  await prisma.plan.create({ data: { key: PLAN2_KEY, name: "ITest Plan 2", basePrice: "200.00", includedAiUnits: 5000, active: true } });
  await prisma.subscription.create({
    data: { billableEntityId: entityA, planKey: PLAN_KEY, status: "ACTIVE", currentPeriodStart: periodStart, currentPeriodEnd: periodEnd },
  });

  // Real ledger state: plan allowance lot + a purchased lot, then consumption.
  await grantUnits({ tenantId: tenantA, bucket: "INCLUDED", grantType: "PLAN", units: 1000, periodKey, includedAllowance: 1000, source: "itest" });
  await grantUnits({ tenantId: tenantA, bucket: "PURCHASED", grantType: "PURCHASE", units: 200, source: "itest", referenceId: `${RUN}-buy1` });
  await consumeUnits(tenantA, 240, { periodKey, source: "itest" });

  await prisma.autoPurchasePolicy.create({
    data: { billableEntityId: entityA, enabled: true, thresholdPct: 10, maxMonthlySpend: "500.00", currency: "ILS", monthSpendKey: periodKeyFor(new Date()), monthSpentAmount: "123.45" },
  });
}, 30_000);

afterAll(async () => {
  // Sweep EVERY tenant this run created (slug prefix), in dependency order -
  // nothing itest-prefixed may survive in the shared dev DB.
  const tenants = await prisma.tenant.findMany({ where: { slug: { startsWith: RUN } }, select: { id: true } });
  const ids = tenants.map((t) => t.id);
  await prisma.aiUnitLedgerEntry.deleteMany({ where: { tenantId: { in: ids } } });
  await prisma.aiUnitLot.deleteMany({ where: { tenantId: { in: ids } } });
  await prisma.tenantAiBalance.deleteMany({ where: { tenantId: { in: ids } } });
  await prisma.autoPurchasePolicy.deleteMany({ where: { billableEntityId: entityA } });
  await prisma.subscription.deleteMany({ where: { billableEntityId: entityA } });
  await prisma.plan.deleteMany({ where: { key: { in: [PLAN_KEY, PLAN2_KEY] } } });
  await prisma.billableEntityTenant.deleteMany({ where: { tenantId: { in: ids } } });
  await prisma.billableEntity.deleteMany({ where: { displayName: { startsWith: RUN } } });
  await prisma.tenant.deleteMany({ where: { id: { in: ids } } });
  await prisma.$disconnect();
}, 30_000);

describe("credit-summary: one canonical contract from the real ledger", () => {
  it("composes plan allowance, ledger consumption, purchased balance and period", async () => {
    ctx.tenantId = tenantA;
    const res = await request(app).get("/api/billing/credit-summary");
    expect(res.status).toBe(200);
    const s = res.body;

    // Plan allowance from the current subscription's plan (entitlement).
    expect(s.plan.planId).toBe(PLAN_KEY);
    expect(s.plan.includedCredits).toBe(1000);

    // Consumption strictly from the ledger: 240 consumed → 760 remain.
    expect(s.usage.consumedCredits).toBe(240);
    expect(s.usage.remainingPlanCredits).toBe(760);
    expect(s.usage.consumedPct).toBe(24);

    // Purchased balance untouched by INCLUDED-first consumption.
    expect(s.purchasedCredits.balance).toBe(200);
    expect(s.totalAvailableCredits).toBe(960);

    // Period reset from the subscription period.
    expect(new Date(s.period.resetsAt).getTime()).toBe(periodEnd.getTime());

    // Auto-purchase MONEY spend (separate concept from credit consumption).
    expect(s.usageCredits.enabled).toBe(true);
    expect(s.usageCredits.spentAmount).toBe("123.45");
    expect(s.usageCredits.monthlySpendLimit).toBe("500.00");
  });

  it("shows 0 money-spend when the policy's spend window is a STALE month", async () => {
    ctx.tenantId = tenantA;
    await prisma.autoPurchasePolicy.update({ where: { billableEntityId: entityA }, data: { monthSpendKey: "2020-01" } });
    const res = await request(app).get("/api/billing/credit-summary");
    expect(res.body.usageCredits.spentAmount).toBe("0.00");
    await prisma.autoPurchasePolicy.update({ where: { billableEntityId: entityA }, data: { monthSpendKey: periodKeyFor(new Date()) } });
  });

  it("is tenant-isolated: tenant B sees ONLY its own (empty) wallet", async () => {
    ctx.tenantId = tenantB;
    const res = await request(app).get("/api/billing/credit-summary");
    expect(res.status).toBe(200);
    expect(res.body.usage.consumedCredits).toBe(0);
    expect(res.body.purchasedCredits.balance).toBe(0);
    expect(res.body.totalAvailableCredits).toBe(0);
    expect(res.body.plan.planId).toBeNull();
    ctx.tenantId = tenantA;
  });

  it("follows a plan change during the period (display allowance = new plan; ledger untouched)", async () => {
    ctx.tenantId = tenantA;
    await prisma.subscription.update({ where: { billableEntityId: entityA }, data: { planKey: PLAN2_KEY } });
    const res = await request(app).get("/api/billing/credit-summary");
    // The contract's plan block reflects the NEW entitlement immediately...
    expect(res.body.plan.planId).toBe(PLAN2_KEY);
    expect(res.body.plan.includedCredits).toBe(5000);
    // ...while consumed/remaining stay ledger-truth (upgrade grants land via
    // the subscription service's own grant, which is out of scope here).
    expect(res.body.usage.consumedCredits).toBe(240);
    await prisma.subscription.update({ where: { billableEntityId: entityA }, data: { planKey: PLAN_KEY } });
  });
});

describe("wallet: concurrency, duplicates, reversal (real DB)", () => {
  it("parallel consumption never oversubtracts or drives a lot negative", async () => {
    const { tenantId } = await mkTenant("conc");
    await grantUnits({ tenantId, bucket: "INCLUDED", grantType: "PLAN", units: 1000, periodKey, includedAllowance: 1000, source: "itest" });

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => consumeUnits(tenantId, 100, { periodKey, source: `itest-c${i}` })),
    );
    const consumedTotal = results.reduce((a, r) => a + r.consumed, 0);
    const bal = await getBalance(tenantId);

    // Supply == demand: everything consumed, nothing negative, books balance.
    expect(bal.includedRemaining).toBeGreaterThanOrEqual(0);
    expect(consumedTotal).toBeLessThanOrEqual(1000);
    expect(Math.round(consumedTotal + bal.includedRemaining)).toBe(1000);

    const negativeLots = await prisma.aiUnitLot.count({ where: { tenantId, unitsRemaining: { lt: 0 } } });
    expect(negativeLots).toBe(0);
  }, 30_000);

  it("reversal by reference is exact and idempotent (duplicate event → no double refund)", async () => {
    const { tenantId } = await mkTenant("dup");
    await grantUnits({ tenantId, bucket: "PURCHASED", grantType: "PURCHASE", units: 300, source: "itest", referenceId: `${RUN}-dupbuy` });

    const first = await refundUnitsForReference(tenantId, `${RUN}-dupbuy`, "itest-reversal");
    expect(first.reclaimed).toBe(300);
    // Duplicate provider event replayed → nothing left to reclaim.
    const second = await refundUnitsForReference(tenantId, `${RUN}-dupbuy`, "itest-reversal");
    expect(second.reclaimed).toBe(0);

    const bal = await getBalance(tenantId);
    expect(bal.purchasedRemaining).toBe(0);
  }, 30_000);

  it("reports shortfall honestly when demand exceeds supply", async () => {
    const { tenantId } = await mkTenant("short");
    await grantUnits({ tenantId, bucket: "INCLUDED", grantType: "PLAN", units: 50, periodKey, includedAllowance: 50, source: "itest" });
    const r = await consumeUnits(tenantId, 80, { periodKey, source: "itest" });
    expect(r.consumed).toBe(50);
    expect(r.shortfall).toBe(30);
    expect((await getBalance(tenantId)).total).toBe(0);
  }, 30_000);
});
