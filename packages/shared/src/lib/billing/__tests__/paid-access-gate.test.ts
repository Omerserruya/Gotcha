/**
 * Every way the gate can refuse someone, exercised.
 *
 * The gate grew seven new denial reasons - expired trials, expired POCs, a
 * past-due grace period, a capability outside the plan, paused and pending
 * subscriptions - and not one of them had a test. They were reachable only
 * through code paths the existing tests never set up, so the whole set could
 * have been inverted and every suite would still have passed.
 *
 * These are the decisions that cut a paying customer off mid-conversation. The
 * cost of getting one wrong is not a failed request, it is an organization's
 * bot going silent in front of their customers, so each reason is set up
 * explicitly rather than inferred from a neighbouring case.
 */
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { prisma } from "../../prisma";
import { checkPaidAccess, pastDueGraceHours } from "../entitlement-gate";

const RUN = `gate-${Date.now()}`;
const tenantIds: string[] = [];
const entityIds: string[] = [];
const ORIGINAL = { ...process.env };

const HOUR = 3_600_000;
const ago = (h: number) => new Date(Date.now() - h * HOUR);
const ahead = (h: number) => new Date(Date.now() + h * HOUR);

type SubOpts = {
  status?: string;
  enforcementEnabled?: boolean;
  trialEndsAt?: Date | null;
  currentPeriodEnd?: Date | null;
  planKey?: string;
  planVersion?: number;
};

async function tenantWith(sub: SubOpts | null, tenantStatus: any = "ACTIVE") {
  const n = `${RUN}-${Math.random().toString(36).slice(2, 8)}`;
  const t = await prisma.tenant.create({ data: { name: n, slug: n, status: tenantStatus } });
  const e = await prisma.billableEntity.create({ data: { displayName: n } });
  await prisma.billableEntityTenant.create({ data: { billableEntityId: e.id, tenantId: t.id } });
  tenantIds.push(t.id);
  entityIds.push(e.id);

  if (sub) {
    await prisma.subscription.create({
      data: {
        billableEntityId: e.id,
        planKey: sub.planKey ?? "ai_workforce",
        planVersion: sub.planVersion ?? 1,
        status: (sub.status ?? "ACTIVE") as any,
        enforcementEnabled: sub.enforcementEnabled ?? true,
        trialEndsAt: sub.trialEndsAt ?? null,
        currentPeriodEnd: sub.currentPeriodEnd ?? null,
        snapshotPrice: 499,
        snapshotCurrency: "USD",
        snapshotIncludedCredits: 2000,
      },
    });
  }
  return t;
}

beforeEach(() => {
  process.env.BILLING_ENFORCEMENT_MODE = "enforce";
  delete process.env.BILLING_PAST_DUE_GRACE_HOURS;
});

afterAll(async () => {
  await prisma.subscription.deleteMany({ where: { billableEntityId: { in: entityIds } } });
  await prisma.billableEntityTenant.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  process.env = { ...ORIGINAL };
});

describe("the organization's own state", () => {
  it("refuses a tenant awaiting payment", async () => {
    const t = await tenantWith(null, "PENDING_PAYMENT");
    const d = await checkPaidAccess({ tenantId: t.id });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("payment_required");
  });

  it("refuses a suspended tenant", async () => {
    const t = await tenantWith({ status: "ACTIVE" }, "SUSPENDED");
    const d = await checkPaidAccess({ tenantId: t.id });
    expect(d.reason).toBe("tenant_suspended");
  });

  it("refuses an active tenant with no subscription at all", async () => {
    const t = await tenantWith(null);
    const d = await checkPaidAccess({ tenantId: t.id });
    expect(d.reason).toBe("no_subscription");
  });

  it("leaves an onboarding tenant alone", async () => {
    const t = await tenantWith(null, "PENDING_ONBOARDING");
    // No subscription by definition, and onboarding is how one gets bought.
    // The tenant access matrix keeps the paid product out of reach anyway.
    expect((await checkPaidAccess({ tenantId: t.id })).allowed).toBe(true);
  });
});

describe("subscription states", () => {
  it.each([
    ["PENDING", "subscription_pending"],
    ["SUSPENDED", "subscription_suspended"],
    ["CANCELED", "subscription_canceled"],
    ["PAUSED", "subscription_paused"],
  ])("refuses a %s subscription as %s", async (status, reason) => {
    const t = await tenantWith({ status });
    const d = await checkPaidAccess({ tenantId: t.id });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe(reason);
  });

  it("allows a grandfathered subscription through untouched", async () => {
    const t = await tenantWith({ status: "CANCELED", enforcementEnabled: false });
    // A commercial decision recorded on the row, not an accident - and it wins
    // over a status that would otherwise refuse.
    expect((await checkPaidAccess({ tenantId: t.id })).allowed).toBe(true);
  });
});

describe("trials end", () => {
  it("allows a trial that is still running", async () => {
    const t = await tenantWith({ status: "TRIALING", trialEndsAt: ahead(48) });
    const d = await checkPaidAccess({ tenantId: t.id, skipCreditCheck: true });
    expect(d.allowed).toBe(true);
  });

  it("refuses a trial that has ended", async () => {
    const t = await tenantWith({ status: "TRIALING", trialEndsAt: ago(1) });
    const d = await checkPaidAccess({ tenantId: t.id });
    expect(d.reason).toBe("trial_expired");
  });

  it("falls back to the period end when no trial end was set", async () => {
    // A trial with no explicit end used to run forever.
    const t = await tenantWith({ status: "TRIALING", trialEndsAt: null, currentPeriodEnd: ago(1) });
    expect((await checkPaidAccess({ tenantId: t.id })).reason).toBe("trial_expired");
  });
});

describe("a failed renewal gets a grace period, and then does not", () => {
  it("keeps serving inside the grace window", async () => {
    const t = await tenantWith({ status: "PAST_DUE", currentPeriodEnd: ago(1) });
    // An expired card is the ordinary case. Cutting someone off the hour a
    // renewal fails punishes it as harshly as never paying.
    const d = await checkPaidAccess({ tenantId: t.id, skipCreditCheck: true });
    expect(d.allowed).toBe(true);
  });

  it("refuses once the grace period has passed", async () => {
    const t = await tenantWith({ status: "PAST_DUE", currentPeriodEnd: ago(pastDueGraceHours() + 2) });
    const d = await checkPaidAccess({ tenantId: t.id });
    expect(d.reason).toBe("past_due_grace_expired");
  });

  it("honours a configured grace period", async () => {
    process.env.BILLING_PAST_DUE_GRACE_HOURS = "1";
    const t = await tenantWith({ status: "PAST_DUE", currentPeriodEnd: ago(3) });
    expect((await checkPaidAccess({ tenantId: t.id })).reason).toBe("past_due_grace_expired");
  });

  it("treats a grace period of zero as no grace", async () => {
    process.env.BILLING_PAST_DUE_GRACE_HOURS = "0";
    const t = await tenantWith({ status: "PAST_DUE", currentPeriodEnd: ago(1) });
    // 0 must mean zero, not "unset, use the default" - a deployment that
    // deliberately allows none would otherwise silently get 72 hours.
    expect((await checkPaidAccess({ tenantId: t.id })).reason).toBe("past_due_grace_expired");
  });
});

describe("the mode decides what a refusal does, not whether one is reached", () => {
  it("decides nothing when off", async () => {
    process.env.BILLING_ENFORCEMENT_MODE = "off";
    const t = await tenantWith(null, "PENDING_PAYMENT");
    const d = await checkPaidAccess({ tenantId: t.id });
    expect(d.allowed).toBe(true);
    expect(d.wouldDeny).toBe(false);
  });

  it("evaluates and reports but allows in audit", async () => {
    process.env.BILLING_ENFORCEMENT_MODE = "audit";
    const t = await tenantWith(null, "PENDING_PAYMENT");
    const d = await checkPaidAccess({ tenantId: t.id });
    // The whole point of the mode: measure the blast radius before anyone is
    // refused mid-conversation.
    expect(d.allowed).toBe(true);
    expect(d.wouldDeny).toBe(true);
    expect(d.reason).toBe("payment_required");
  });

  it("forecasts under an assumed mode while switched off", async () => {
    process.env.BILLING_ENFORCEMENT_MODE = "off";
    const t = await tenantWith(null, "PENDING_PAYMENT");
    const d = await checkPaidAccess({ tenantId: t.id, assumeMode: "enforce" });
    // What the impact report relies on. Without it the report would have to
    // restate the rules to predict them, and would drift from them.
    expect(d.wouldDeny).toBe(true);
    expect(d.reason).toBe("payment_required");
  });
});

describe("credits are checked unless a caller opts out", () => {
  it("refuses an otherwise-fine tenant with an empty wallet", async () => {
    const t = await tenantWith({ status: "ACTIVE" });
    const d = await checkPaidAccess({ tenantId: t.id });
    // The regression this guards: making the wallet check conditional on a
    // feature being named meant the plain question - "may this tenant run AI" -
    // answered yes with nothing left to spend.
    expect(d.reason).toBe("credits_exhausted");
  });

  it("skips the wallet only when asked to", async () => {
    const t = await tenantWith({ status: "ACTIVE" });
    expect((await checkPaidAccess({ tenantId: t.id, skipCreditCheck: true })).allowed).toBe(true);
  });
});
