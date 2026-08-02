/**
 * Finishing onboarding must not buy the product.
 *
 * `POST /onboarding/complete` flipped every tenant to ACTIVE. For a tenant
 * provisioned on a paid plan that was the whole ballgame: the access matrix
 * grants ACTIVE the full application, so clicking through setup was a way
 * to get a paid workspace without paying for it. Nothing failed loudly -
 * the tenant simply became active and the checkout sat there unpaid.
 *
 * DB-backed and driving the real router, because the thing under test is a
 * conditional inside a transaction. A mocked prisma would only prove the
 * mock was called.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import { prisma } from "@chatcenter/shared";

const RUN = `paygate-${Date.now()}`;
const tenantIds: string[] = [];
const identityIds: string[] = [];
const ctx: { tenantId: string; userId: string } = { tenantId: "", userId: "" };

// Auth is not what this test is about; the transaction is. Everything else
// stays real, including prisma.
vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    authenticate: (req: any, _res: any, next: any) => {
      req.user = { userId: ctx.userId, tenantId: ctx.tenantId, role: "ADMIN", email: "owner@example.com" };
      next();
    },
    resolveTenant: (req: any, _res: any, next: any) => {
      req.tenantId = ctx.tenantId;
      next();
    },
    requireRole: () => (_req: any, _res: any, next: any) => next(),
  };
});

// Side effects that reach other services or a mailbox. Their absence is not
// what is being tested, and one of them (the activation email) is asserted
// on directly below.
const sendActivationConfirmation = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../services/notification.service", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendActivationConfirmation,
}));
vi.mock("../services/nudge-engine.service", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  scheduleOnboardingNudge: vi.fn().mockResolvedValue(undefined),
}));

import onboardingRouter from "../routes/onboarding";

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/onboarding", onboardingRouter);
  return a;
}

async function seedTenant(status: "PENDING_PAYMENT" | "PENDING_ONBOARDING") {
  const n = `${RUN}-${Math.random().toString(36).slice(2, 8)}`;
  const tenant = await prisma.tenant.create({ data: { name: n, slug: n, status } });
  tenantIds.push(tenant.id);
  const identity = await prisma.identity.create({
    data: { email: `${n}@example.com`, name: "Owner" },
  });
  identityIds.push(identity.id);
  const user = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      identityId: identity.id,
      email: `${n}@example.com`,
      name: "Owner",
      role: "ADMIN",
      isActive: true,
    },
  });
  // /complete refuses without a business profile, which is a separate rule.
  await prisma.businessProfile.create({
    data: {
      tenantId: tenant.id,
      organizationName: n,
      industry: "test",
      businessDescription: "seeded by a test",
      businessPriority: "FAST_RESPONSE",
      estimatedDailyConversations: 10,
      numberOfAgents: 1,
    },
  });
  ctx.tenantId = tenant.id;
  ctx.userId = user.id;
  return tenant;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterAll(async () => {
  await prisma.tenantOnboarding.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.businessProfile.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.department.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.user.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.billableEntityTenant.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  await prisma.identity.deleteMany({ where: { id: { in: identityIds } } });
});

describe("a tenant awaiting payment", () => {
  it("stays PENDING_PAYMENT when onboarding completes", async () => {
    const tenant = await seedTenant("PENDING_PAYMENT");

    const res = await request(app())
      .post("/api/onboarding/complete")
      .send({ skipCoreSystem: true, skipEmployee: true });

    expect(res.status).toBe(200);
    expect(res.body.data.paymentRequired).toBe(true);
    expect(res.body.data.status).toBe("PENDING_PAYMENT");

    const after = await prisma.tenant.findUnique({ where: { id: tenant.id }, select: { status: true } });
    expect(after?.status).toBe("PENDING_PAYMENT");
  });

  it("still records the onboarding work, so nothing has to be redone after paying", async () => {
    // The customer's setup is real. Refusing to save it would punish them
    // for the order they did things in.
    const tenant = await seedTenant("PENDING_PAYMENT");

    await request(app()).post("/api/onboarding/complete").send({ skipCoreSystem: true, skipEmployee: true });

    const onboarding = await prisma.tenantOnboarding.findUnique({ where: { tenantId: tenant.id } });
    expect(onboarding?.currentStep).toBe("COMPLETED");
    expect(onboarding?.completedAt).toBeTruthy();
  });

  it("does not send an activation email for a workspace that is not open", async () => {
    await seedTenant("PENDING_PAYMENT");
    await request(app()).post("/api/onboarding/complete").send({ skipCoreSystem: true, skipEmployee: true });
    expect(sendActivationConfirmation).not.toHaveBeenCalled();
  });

  it("grants no subscription and no credits", async () => {
    // Activation - the subscription and the included credits - belongs to
    // checkout-activation.service and to verified payment alone.
    const tenant = await seedTenant("PENDING_PAYMENT");
    await request(app()).post("/api/onboarding/complete").send({ skipCoreSystem: true, skipEmployee: true });

    const link = await prisma.billableEntityTenant.findFirst({ where: { tenantId: tenant.id } });
    if (link) {
      const sub = await prisma.subscription.findUnique({ where: { billableEntityId: link.billableEntityId } });
      expect(sub).toBeNull();
    }
    const ledger = await prisma.creditTransaction.findMany({ where: { tenantId: tenant.id } });
    expect(ledger).toHaveLength(0);
  });

  it("is still refused the paid application afterwards", async () => {
    // The point of the whole fix: the access matrix must still say no.
    const { evaluateTenantAccess } = await import("@chatcenter/shared");
    const tenant = await seedTenant("PENDING_PAYMENT");
    await request(app()).post("/api/onboarding/complete").send({ skipCoreSystem: true, skipEmployee: true });

    const after = await prisma.tenant.findUnique({ where: { id: tenant.id }, select: { status: true } });
    const decision = evaluateTenantAccess(after!.status, "FULL_APPLICATION");
    expect(decision.allow).toBe(false);
    if (!decision.allow) {
      expect(decision.code).toBe("TENANT_PAYMENT_REQUIRED");
      expect(decision.httpStatus).toBe(402);
    }
  });
});

describe("a tenant with no billing", () => {
  it("still activates exactly as before", async () => {
    // The guard must not have made onboarding conditional for everybody
    // else. This is the ordinary, unpaid path.
    const tenant = await seedTenant("PENDING_ONBOARDING");

    const res = await request(app())
      .post("/api/onboarding/complete")
      .send({ skipCoreSystem: true, skipEmployee: true });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("ACTIVE");
    expect(res.body.data.paymentRequired).toBe(false);

    const after = await prisma.tenant.findUnique({ where: { id: tenant.id }, select: { status: true } });
    expect(after?.status).toBe("ACTIVE");
    expect(sendActivationConfirmation).toHaveBeenCalled();
  });
});
