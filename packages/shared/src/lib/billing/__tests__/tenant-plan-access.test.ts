/**
 * The tenant-commercial invariant: every organization has exactly one plan.
 *
 * Two layers, tested separately on purpose. The classifier is pure and gets the
 * exhaustive treatment - every access source, every way one lapses, and the
 * conflict it must refuse to resolve. The resolver and the access matrix then
 * get the cases that can only be wrong end-to-end: a tenant that looks healthy
 * by status and holds nothing, and a POC whose window has closed.
 *
 * The case that motivated all of it: an ACTIVE tenant with no subscription
 * passed every HTTP gate in the product, because status was the only question
 * being asked and status knows nothing about money.
 */
import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "../../prisma";
import { classifyTenantPlanAccess, subscriptionIsActiveSource } from "../tenant-plan-access";
import {
  resolveTenantPlanAccess,
  resolveTenantPlanAccessBatch,
  tenantPlanGateFacts,
} from "../tenant-plan-resolver";
import { evaluateTenantAccess } from "../../tenant-access-policy";

const RUN = `plan-${Date.now()}`;
const tenantIds: string[] = [];
const entityIds: string[] = [];

const HOUR = 3_600_000;
const ago = (h: number) => new Date(Date.now() - h * HOUR);
const ahead = (h: number) => new Date(Date.now() + h * HOUR);

const paidSub = (over: Record<string, unknown> = {}) => ({
  planKey: "foundation",
  planVersion: 1,
  status: "ACTIVE",
  planKind: "PUBLIC",
  planName: "Foundation",
  ...over,
});

async function tenant(opts: {
  status?: string;
  sub?: null | {
    planKey?: string;
    status?: string;
    kind?: string;
    currentPeriodEnd?: Date | null;
    cancelAtPeriodEnd?: boolean;
  };
  checkout?: boolean;
  provisioningState?: string;
} = {}) {
  const n = `${RUN}-${Math.random().toString(36).slice(2, 8)}`;
  const t = await prisma.tenant.create({
    data: { name: n, slug: n, status: (opts.status ?? "ACTIVE") as any },
  });
  tenantIds.push(t.id);

  if (opts.sub) {
    const e = await prisma.billableEntity.create({ data: { displayName: n } });
    entityIds.push(e.id);
    await prisma.billableEntityTenant.create({ data: { billableEntityId: e.id, tenantId: t.id } });

    const planKey = opts.sub.planKey ?? `plan-${n}`;
    await prisma.plan.create({
      data: {
        key: planKey,
        version: 1,
        name: `Plan ${n}`,
        kind: (opts.sub.kind ?? "PUBLIC") as any,
        basePrice: opts.sub.kind === "POC" ? null : 39,
        includedAiUnits: 0,
      },
    });
    await prisma.subscription.create({
      data: {
        billableEntityId: e.id,
        planKey,
        planVersion: 1,
        status: (opts.sub.status ?? "ACTIVE") as any,
        enforcementEnabled: true,
        cancelAtPeriodEnd: opts.sub.cancelAtPeriodEnd ?? false,
        currentPeriodEnd: opts.sub.currentPeriodEnd ?? null,
      },
    });
  }

  if (opts.checkout) {
    await prisma.pendingCheckout.create({
      data: {
        reference: `chk_${n}`,
        tenantId: t.id,
        planKey: "foundation",
        planVersion: 1,
        snapshotPrice: 39,
        snapshotCurrency: "USD",
        snapshotIncludedCredits: 750,
        amount: 39,
        currency: "USD",
        status: "PENDING",
        expiresAt: ahead(72),
        idempotencyKey: `checkout:${n}`,
      },
    });
  }

  if (opts.provisioningState) {
    await prisma.tenantBillingProvisioningRequest.create({
      data: {
        tenantId: t.id,
        mode: "PAID_PLAN",
        planVersionId: "whatever",
        idempotencyKey: `provisioning:${n}`,
        state: opts.provisioningState as any,
      },
    });
  }

  return t;
}

afterAll(async () => {
  await prisma.tenantBillingProvisioningRequest.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.pendingCheckout.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.subscription.deleteMany({ where: { billableEntityId: { in: entityIds } } });
  await prisma.billableEntityTenant.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.billableEntity.deleteMany({ where: { id: { in: entityIds } } });
  await prisma.plan.deleteMany({ where: { key: { startsWith: `plan-${RUN}` } } });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
});

describe("the classifier: which access source, if any", () => {
  it("an active paid subscription is access, and names the plan", () => {
    const v = classifyTenantPlanAccess({ tenantStatus: "ACTIVE", subscriptions: [paidSub()] });
    expect(v.active).toBe(true);
    expect(v.source).toBe("PAID");
    expect(v.state).toBe("ACTIVE_PAID");
    expect(v.label).toBe("Foundation");
  });

  it("an active POC is access", () => {
    const v = classifyTenantPlanAccess({
      tenantStatus: "ACTIVE",
      subscriptions: [paidSub({ planKind: "POC", currentPeriodEnd: ahead(48) })],
    });
    expect(v.active).toBe(true);
    expect(v.source).toBe("POC");
    expect(v.label).toBe("POC");
  });

  it("a trial inside its window is access, and past it is not", () => {
    const live = classifyTenantPlanAccess({
      tenantStatus: "ACTIVE",
      subscriptions: [paidSub({ status: "TRIALING", trialEndsAt: ahead(24) })],
    });
    expect(live.active).toBe(true);
    expect(live.source).toBe("TRIAL");

    const done = classifyTenantPlanAccess({
      tenantStatus: "ACTIVE",
      subscriptions: [paidSub({ status: "TRIALING", trialEndsAt: ago(1) })],
    });
    expect(done.active).toBe(false);
    expect(done.state).toBe("EXPIRED");
  });

  it("a manual contract is access, reported as its own source", () => {
    const v = classifyTenantPlanAccess({
      tenantStatus: "ACTIVE",
      subscriptions: [paidSub()],
      hasManualContract: true,
    });
    expect(v.active).toBe(true);
    expect(v.source).toBe("MANUAL_CONTRACT");
  });

  it("a POC past its expiry is NOT access, even left ACTIVE", () => {
    // The sweep that cancels expired POCs runs on a schedule. Between the
    // window closing and the sweep arriving, the subscription row still says
    // ACTIVE - and if that were enough, an unattended pilot would keep running.
    const v = classifyTenantPlanAccess({
      tenantStatus: "ACTIVE",
      subscriptions: [paidSub({ planKind: "POC", status: "ACTIVE", currentPeriodEnd: ago(1) })],
    });
    expect(v.active).toBe(false);
    expect(v.state).toBe("EXPIRED");
  });

  it("past due is access inside the grace window and not after it", () => {
    const inGrace = paidSub({ status: "PAST_DUE", currentPeriodEnd: ago(1) });
    expect(subscriptionIsActiveSource(inGrace, new Date(), 72)).toBe(true);
    const outOfGrace = paidSub({ status: "PAST_DUE", currentPeriodEnd: ago(100) });
    expect(subscriptionIsActiveSource(outOfGrace, new Date(), 72)).toBe(false);
  });

  it("pending, suspended, canceled and paused are not access", () => {
    for (const status of ["PENDING", "SUSPENDED", "CANCELED", "PAUSED"]) {
      const v = classifyTenantPlanAccess({ tenantStatus: "ACTIVE", subscriptions: [paidSub({ status })] });
      expect(v.active, status).toBe(false);
      expect(v.state, status).toBe("EXPIRED");
    }
  });

  it("a pending checkout is not a plan, but it is not 'missing' either", () => {
    const v = classifyTenantPlanAccess({
      tenantStatus: "PENDING_PAYMENT",
      subscriptions: [],
      hasOpenCheckout: true,
    });
    expect(v.active).toBe(false);
    expect(v.state).toBe("PENDING_PAYMENT");
    // The action for this is "wait or resend", not "choose a plan".
    expect(v.needsReview).toBe(false);
  });

  it("an unfinished provisioning request is repairable, not missing", () => {
    const v = classifyTenantPlanAccess({
      tenantStatus: "PENDING_ADMIN_SETUP",
      subscriptions: [],
      provisioningIncomplete: true,
    });
    expect(v.state).toBe("SETUP_INCOMPLETE");
    expect(v.needsReview).toBe(true);
    expect(v.reviewReason).toBe("setup_incomplete");
  });

  it("nothing at all is MISSING and requires action", () => {
    const v = classifyTenantPlanAccess({ tenantStatus: "ACTIVE", subscriptions: [] });
    expect(v.active).toBe(false);
    expect(v.state).toBe("MISSING");
    expect(v.label).toBe("Missing plan, requires action");
    expect(v.reviewReason).toBe("no_plan");
  });

  it("two live access sources are never resolved silently", () => {
    const v = classifyTenantPlanAccess({
      tenantStatus: "ACTIVE",
      subscriptions: [paidSub(), paidSub({ planKind: "POC", currentPeriodEnd: ahead(48) })],
    });
    // Picking one would decide a commercial question this code cannot answer.
    expect(v.state).toBe("CONFLICTING");
    expect(v.active).toBe(false);
    expect(v.needsReview).toBe(true);
    expect(v.reviewReason).toBe("multiple_active_sources");
  });

  it("never returns an empty label, in any state", () => {
    const states = [
      classifyTenantPlanAccess({ tenantStatus: "ACTIVE", subscriptions: [] }),
      classifyTenantPlanAccess({ tenantStatus: "PENDING_PAYMENT", subscriptions: [], hasOpenCheckout: true }),
      classifyTenantPlanAccess({ tenantStatus: "ACTIVE", subscriptions: [paidSub({ status: "CANCELED" })] }),
      classifyTenantPlanAccess({ tenantStatus: "ACTIVE", subscriptions: [paidSub(), paidSub()] }),
    ];
    for (const v of states) expect(v.label.length).toBeGreaterThan(0);
  });
});

describe("the access matrix asks both questions", () => {
  it("blocks the paid product for an ACTIVE tenant with no plan", () => {
    const d = evaluateTenantAccess("ACTIVE", "FULL_APPLICATION", { active: false });
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.code).toBe("TENANT_PLAN_REQUIRED");
      expect(d.httpStatus).toBe(402);
    }
  });

  it("says PAYMENT_REQUIRED, not PLAN_REQUIRED, when payment is the reason", () => {
    const d = evaluateTenantAccess("PENDING_PAYMENT", "FULL_APPLICATION", { active: false, pendingPayment: true });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.code).toBe("TENANT_PAYMENT_REQUIRED");
  });

  it("allows identity, onboarding and payment setup without a plan", () => {
    // The list of things a plan-less tenant must still be able to do: log in,
    // secure the account, finish setup, and pay. Denying these would make the
    // state unrecoverable from inside the product.
    expect(evaluateTenantAccess("ACTIVE", "IDENTITY", { active: false }).allow).toBe(true);
    expect(evaluateTenantAccess("PENDING_ONBOARDING", "ONBOARDING", { active: false }).allow).toBe(true);
    expect(evaluateTenantAccess("PENDING_PAYMENT", "PAYMENT_SETUP", { active: false }).allow).toBe(true);
  });

  it("still allows the product when a plan is held", () => {
    expect(evaluateTenantAccess("ACTIVE", "FULL_APPLICATION", { active: true }).allow).toBe(true);
  });

  it("does not deny when the plan was not asked about", () => {
    // Omitted facts must not read as "no plan": a caller with no database at
    // hand would otherwise deny the product on missing information.
    expect(evaluateTenantAccess("ACTIVE", "FULL_APPLICATION").allow).toBe(true);
  });
});

describe("the resolver, against the database", () => {
  it("an ACTIVE tenant with no subscription resolves to MISSING", async () => {
    const t = await tenant({ status: "ACTIVE", sub: null });
    const v = await resolveTenantPlanAccess(t.id);
    expect(v.state).toBe("MISSING");
    expect(v.active).toBe(false);
  });

  it("an ACTIVE tenant with a live subscription resolves to access", async () => {
    const t = await tenant({ status: "ACTIVE", sub: {} });
    const v = await resolveTenantPlanAccess(t.id);
    expect(v.active).toBe(true);
    expect(v.source).toBe("PAID");
  });

  it("a PENDING_PAYMENT tenant with a checkout is pending, not missing", async () => {
    const t = await tenant({ status: "PENDING_PAYMENT", sub: null, checkout: true });
    const v = await resolveTenantPlanAccess(t.id);
    expect(v.state).toBe("PENDING_PAYMENT");
  });

  it("a failed provisioning leaves a repairable state, not an active one", async () => {
    const t = await tenant({ status: "PENDING_ADMIN_SETUP", sub: null, provisioningState: "FAILED_RETRYABLE" });
    const v = await resolveTenantPlanAccess(t.id);
    expect(v.active).toBe(false);
    expect(v.state).toBe("SETUP_INCOMPLETE");
  });

  it("an expired POC no longer holds access", async () => {
    const t = await tenant({ status: "ACTIVE", sub: { kind: "POC", currentPeriodEnd: ago(1) } });
    const v = await resolveTenantPlanAccess(t.id);
    expect(v.active).toBe(false);
    expect(v.state).toBe("EXPIRED");
  });

  it("the request gate's fast path agrees with the full resolver", async () => {
    // The gate answers in one or two queries where the resolver takes six. That
    // is only safe while they agree - a faster second opinion about who is
    // entitled is how the console ends up showing one thing and the product
    // doing another.
    const cases = [
      await tenant({ status: "ACTIVE", sub: {} }),
      await tenant({ status: "ACTIVE", sub: null }),
      await tenant({ status: "PENDING_PAYMENT", sub: null, checkout: true }),
      await tenant({ status: "ACTIVE", sub: { kind: "POC", currentPeriodEnd: ahead(48) } }),
      await tenant({ status: "ACTIVE", sub: { kind: "POC", currentPeriodEnd: ago(1) } }),
      await tenant({ status: "ACTIVE", sub: { status: "CANCELED" } }),
      await tenant({ status: "ACTIVE", sub: { status: "PAST_DUE", currentPeriodEnd: ago(1) } }),
      await tenant({ status: "ACTIVE", sub: { status: "PAST_DUE", currentPeriodEnd: ago(500) } }),
    ];
    for (const t of cases) {
      const full = await resolveTenantPlanAccess(t.id);
      const fast = await tenantPlanGateFacts(t.id);
      expect(fast.active, t.id).toBe(full.active);
      expect(fast.pendingPayment, t.id).toBe(full.state === "PENDING_PAYMENT");
    }
  });

  it("the batch resolver agrees with the single one, tenant for tenant", async () => {
    // They exist so bulk surfaces are fast, not so they can drift. If these
    // ever disagree, the console shows one thing and the gate does another.
    const made = [
      await tenant({ status: "ACTIVE", sub: {} }),
      await tenant({ status: "ACTIVE", sub: null }),
      await tenant({ status: "PENDING_PAYMENT", sub: null, checkout: true }),
      await tenant({ status: "ACTIVE", sub: { kind: "POC", currentPeriodEnd: ahead(48) } }),
    ];
    const batch = await resolveTenantPlanAccessBatch(made.map((t) => t.id));
    for (const t of made) {
      const single = await resolveTenantPlanAccess(t.id);
      expect(batch.get(t.id)?.state, t.id).toBe(single.state);
      expect(batch.get(t.id)?.active, t.id).toBe(single.active);
    }
  });
});
