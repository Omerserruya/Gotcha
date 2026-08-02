/**
 * POC provisioning, which is the act of giving product away.
 *
 * Everything here is about the two ways that goes wrong: giving away more than
 * the operator entered, and giving away more than they selected. Both are silent
 * - a doubled credit budget looks like a generous budget, and a feature nobody
 * chose looks like a feature that was always included - so both are asserted on
 * exact numbers rather than on "it worked".
 *
 * DB-backed, because the allowance is a ledger and the entitlements are rows;
 * neither can be proven from the return value alone.
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { prisma, getBalance, getEffectiveEntitlements, checkPaidAccess } from "@chatcenter/shared";
import {
  provisionPoc,
  expireDuePocs,
  PocProvisioningRefused,
  POC_FEATURE_DOMAINS,
  POC_PLAN_KEY,
} from "../services/poc.service";
import { provisionPaidTenant } from "../services/paid-provisioning.service";
import { auditTenantPlans } from "../services/tenant-plan-audit.service";

const RUN = `poc-${Date.now()}`;
const tenantIds: string[] = [];
const entityIds: string[] = [];
const planIds: string[] = [];

const ahead = (h: number) => new Date(Date.now() + h * 3_600_000);
const ago = (h: number) => new Date(Date.now() - h * 3_600_000);

async function makeTenant(status: string = "PENDING_ADMIN_SETUP") {
  const n = `${RUN}-${Math.random().toString(36).slice(2, 8)}`;
  const t = await prisma.tenant.create({ data: { name: n, slug: n, status: status as any } });
  tenantIds.push(t.id);
  return t;
}

beforeAll(() => {
  // The gate must actually bite for the expiry assertions to mean anything.
  process.env.BILLING_ENFORCEMENT_MODE = "enforce";
});

afterAll(async () => {
  const links = await prisma.billableEntityTenant.findMany({ where: { tenantId: { in: tenantIds } } });
  entityIds.push(...links.map((l) => l.billableEntityId));
  await prisma.aiUnitLedgerEntry.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.aiUnitLot.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.tenantEntitlement.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.tenantFeature.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.paymentAttempt.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.pendingCheckout.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.subscriptionEvent.deleteMany({
    where: { subscription: { billableEntityId: { in: entityIds } } },
  });
  await prisma.subscription.deleteMany({ where: { billableEntityId: { in: entityIds } } });
  await prisma.autoPurchasePolicy.deleteMany({ where: { billableEntityId: { in: entityIds } } });
  await prisma.billableEntityTenant.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.billableEntity.deleteMany({ where: { id: { in: entityIds } } });
  await prisma.plan.deleteMany({ where: { id: { in: planIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
});

describe("POC provisioning", () => {
  it("creates ONE real active subscription immediately", async () => {
    const t = await makeTenant();
    const result = await provisionPoc({
      tenantId: t.id,
      credits: 5_000,
      expiresAt: ahead(24 * 30),
      features: ["conversation"],
      actor: "test",
    });

    const link = await prisma.billableEntityTenant.findUnique({ where: { tenantId: t.id } });
    const subs = await prisma.subscription.findMany({ where: { billableEntityId: link!.billableEntityId } });
    expect(subs).toHaveLength(1);
    expect(subs[0]!.status).toBe("ACTIVE");
    expect(subs[0]!.planKey).toBe(POC_PLAN_KEY);
    expect(subs[0]!.id).toBe(result.subscriptionId);
    // Enforced, not exempt: the point of a POC being a real subscription is
    // that the credit gate bites exactly as it does for a paying customer.
    expect(subs[0]!.enforcementEnabled).toBe(true);
  });

  it("grants the configured budget exactly once, even when run twice", async () => {
    const t = await makeTenant();
    await provisionPoc({ tenantId: t.id, credits: 5_000, expiresAt: ahead(72), features: ["conversation"] });
    const first = await getBalance(t.id);
    expect(first.total).toBe(5_000);

    // A repair, a correction, a double-click. The allowance is REPLACED, never
    // stacked - otherwise the budget would be decided by how many times someone
    // pressed the button.
    await provisionPoc({ tenantId: t.id, credits: 5_000, expiresAt: ahead(72), features: ["conversation"] });
    expect((await getBalance(t.id)).total).toBe(5_000);

    // And a genuinely changed budget replaces rather than adds.
    await provisionPoc({ tenantId: t.id, credits: 2_000, expiresAt: ahead(72), features: ["conversation"] });
    expect((await getBalance(t.id)).total).toBe(2_000);

    // And still exactly one access source. Repair must converge on the POC
    // that exists, not add a second one beside it.
    const link = await prisma.billableEntityTenant.findUnique({ where: { tenantId: t.id } });
    const subs = await prisma.subscription.findMany({ where: { billableEntityId: link!.billableEntityId } });
    expect(subs).toHaveLength(1);
    // Three provisions, and each one waits out the billing-event emit before
    // returning. That is seconds, not milliseconds, so the default 5s budget is
    // not enough - the slowness is the environment's, not the code's.
  }, 30_000);

  it("enables only the selected feature areas", async () => {
    const t = await makeTenant();
    const picked = ["conversation", "analytics"].filter((d) => POC_FEATURE_DOMAINS.includes(d));
    const result = await provisionPoc({ tenantId: t.id, credits: 1_000, expiresAt: ahead(72), features: picked });

    expect(result.featuresEnabled.sort()).toEqual([...picked].sort());
    const effective = await getEffectiveEntitlements(t.id);
    for (const d of picked) {
      expect(effective.get(d)?.value, d).toBeTruthy();
    }
  });

  it("writes an explicit DENIAL for every unselected area", async () => {
    const t = await makeTenant();
    const picked = ["conversation"];
    const result = await provisionPoc({ tenantId: t.id, credits: 1_000, expiresAt: ahead(72), features: picked });

    // License semantics are default-ALLOW, so an absent row means allowed. A
    // POC scoped to conversations that merely failed to mention voice would
    // have granted voice.
    const denied = POC_FEATURE_DOMAINS.filter((d) => !picked.includes(d));
    expect(result.featuresDenied.sort()).toEqual(denied.sort());

    const rows = await prisma.tenantEntitlement.findMany({
      where: { tenantId: t.id, entitlementKey: { in: denied } },
      select: { entitlementKey: true, source: true },
    });
    expect(rows).toHaveLength(denied.length);
    for (const r of rows) expect(r.source).toBe("TRIAL");

    const effective = await getEffectiveEntitlements(t.id);
    for (const d of denied) expect(effective.get(d)?.value, d).toBeFalsy();
  });

  it("stores the exact expiry and schedules no renewal charge", async () => {
    const t = await makeTenant();
    const expiresAt = ahead(24 * 14);
    await provisionPoc({ tenantId: t.id, credits: 1_000, expiresAt, features: ["conversation"] });

    const link = await prisma.billableEntityTenant.findUnique({ where: { tenantId: t.id } });
    const sub = await prisma.subscription.findUnique({ where: { billableEntityId: link!.billableEntityId } });
    expect(sub!.currentPeriodEnd?.toISOString()).toBe(expiresAt.toISOString());
    // cancelAtPeriodEnd is what keeps the renewal sweep away. Without it the
    // billing cycle would eventually try to charge an organization that never
    // gave us a card, and dunning would chase them for it.
    expect(sub!.cancelAtPeriodEnd).toBe(true);
    expect(sub!.snapshotPrice ?? null).toBeNull();

    const policy = await prisma.autoPurchasePolicy.findUnique({
      where: { billableEntityId: link!.billableEntityId },
    });
    // No auto top-up either: an evaluation must not start spending money.
    expect(policy?.enabled ?? false).toBe(false);
  });

  it("blocks paid execution once the POC has expired", async () => {
    const t = await makeTenant("ACTIVE");
    await provisionPoc({ tenantId: t.id, credits: 1_000, expiresAt: ahead(1), features: ["conversation"] });
    expect((await checkPaidAccess({ tenantId: t.id })).allowed).toBe(true);

    // Move the window into the past exactly as time would.
    const link = await prisma.billableEntityTenant.findUnique({ where: { tenantId: t.id } });
    await prisma.subscription.update({
      where: { billableEntityId: link!.billableEntityId },
      data: { currentPeriodEnd: ago(1) },
    });

    const d = await checkPaidAccess({ tenantId: t.id });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("poc_expired");
  });

  it("refuses an expiry in the past, a zero budget and an unknown area", async () => {
    const t = await makeTenant();
    await expect(
      provisionPoc({ tenantId: t.id, credits: 1_000, expiresAt: ago(1), features: ["conversation"] }),
    ).rejects.toThrow(PocProvisioningRefused);
    await expect(
      provisionPoc({ tenantId: t.id, credits: 0, expiresAt: ahead(72), features: ["conversation"] }),
    ).rejects.toThrow(PocProvisioningRefused);
    await expect(
      provisionPoc({ tenantId: t.id, credits: 100, expiresAt: ahead(72), features: ["not_a_domain"] }),
    ).rejects.toThrow(PocProvisioningRefused);
  });
});

describe("paid provisioning grants nothing before payment", () => {
  async function activePublicPlan() {
    const key = `paid-${RUN}-${Math.random().toString(36).slice(2, 8)}`;
    const plan = await prisma.plan.create({
      data: {
        key, version: 1, name: `Paid ${key}`, kind: "PUBLIC", status: "ACTIVE",
        basePrice: 39, currency: "USD", includedAiUnits: 750, billingInterval: "MONTHLY",
      },
    });
    planIds.push(plan.id);
    return plan;
  }

  it("leaves a PENDING_PAYMENT tenant with no subscription and no credits", async () => {
    const t = await makeTenant("PENDING_PAYMENT");
    const plan = await activePublicPlan();

    const out = await provisionPaidTenant({ tenantId: t.id, planVersionId: plan.id, actor: "test" });
    expect(out.checkoutReference).toBeTruthy();

    const link = await prisma.billableEntityTenant.findUnique({ where: { tenantId: t.id } });
    const sub = await prisma.subscription.findUnique({ where: { billableEntityId: link!.billableEntityId } });
    expect(sub).toBeNull();
    expect((await getBalance(t.id)).total).toBe(0);

    // The initial attempt exists but has not been claimed or charged.
    const attempt = await prisma.paymentAttempt.findFirst({ where: { checkoutId: out.checkoutId } });
    expect(attempt!.state).toBe("PENDING");

    // And the tenant is denied the paid product while it waits.
    const d = await checkPaidAccess({ tenantId: t.id });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("payment_required");
  });

  it("refuses a plan scoped to another organization", async () => {
    const other = await makeTenant();
    const t = await makeTenant("PENDING_PAYMENT");
    const scoped = await prisma.plan.create({
      data: {
        key: `scoped-${RUN}-${Math.random().toString(36).slice(2, 8)}`,
        version: 1, name: "Scoped", kind: "CUSTOM", status: "ACTIVE",
        basePrice: 39, currency: "USD", includedAiUnits: 100, tenantId: other.id,
      },
    });
    planIds.push(scoped.id);

    // A negotiated plan belonging to one organization must never be sellable
    // to another - the price on it was agreed with someone else.
    await expect(provisionPaidTenant({ tenantId: t.id, planVersionId: scoped.id })).rejects.toThrow();
  });
});

describe("the expiry sweep", () => {
  async function evaluationOn(kind: "POC" | "TRIAL", planKey: string, periodEnd: Date) {
    const t = await makeTenant("ACTIVE");
    const plan = await prisma.plan.create({
      data: { key: planKey, version: 1, name: planKey, kind, basePrice: null, includedAiUnits: 0, salesOnly: true },
    });
    planIds.push(plan.id);
    const e = await prisma.billableEntity.create({ data: { displayName: planKey } });
    entityIds.push(e.id);
    await prisma.billableEntityTenant.create({ data: { billableEntityId: e.id, tenantId: t.id } });
    await prisma.subscription.create({
      data: {
        billableEntityId: e.id, planKey, planVersion: 1, status: "ACTIVE",
        enforcementEnabled: true, cancelAtPeriodEnd: true, currentPeriodEnd: periodEnd,
      },
    });
    await prisma.tenantEntitlement.create({
      data: {
        tenantId: t.id, entitlementKey: "conversation", valueType: "BOOLEAN",
        value: { bool: true }, source: "TRIAL", expiresAt: periodEnd,
      },
    });
    await prisma.tenantFeature.create({ data: { tenantId: t.id, feature: "conversation", enabled: true } });
    return t;
  }

  it("expires an evaluation on a TEMPLATE plan key, not just the built-in one", async () => {
    // The sweep matched planKey === "poc", which covered the POCs provisioned
    // by this file and nothing else. Template evaluations live on their own
    // plan keys, and this is the only thing that ends them - so they stayed
    // ACTIVE past their date with every feature still switched on.
    const key = `pilot-${RUN}-${Math.random().toString(36).slice(2, 8)}`;
    const t = await evaluationOn("POC", key, ago(1));

    await expireDuePocs();

    const link = await prisma.billableEntityTenant.findUnique({ where: { tenantId: t.id } });
    const sub = await prisma.subscription.findUnique({ where: { billableEntityId: link!.billableEntityId } });
    expect(sub!.status).toBe("CANCELED");
    // And the workspace locks down with it, rather than keeping the last
    // materialized value forever.
    const feature = await prisma.tenantFeature.findFirst({ where: { tenantId: t.id, feature: "conversation" } });
    expect(feature!.enabled).toBe(false);
  });

  it("leaves an evaluation still inside its window alone", async () => {
    const key = `pilot-${RUN}-${Math.random().toString(36).slice(2, 8)}`;
    const t = await evaluationOn("POC", key, ahead(48));
    await expireDuePocs();
    const link = await prisma.billableEntityTenant.findUnique({ where: { tenantId: t.id } });
    const sub = await prisma.subscription.findUnique({ where: { billableEntityId: link!.billableEntityId } });
    expect(sub!.status).toBe("ACTIVE");
  });

  it("never touches a paid subscription between periods", async () => {
    // Widening the sweep from one key to a kind is only safe if it cannot
    // reach a paying customer whose renewal is simply due.
    const t = await makeTenant("ACTIVE");
    const key = `paidsweep-${RUN}-${Math.random().toString(36).slice(2, 8)}`;
    const plan = await prisma.plan.create({
      data: { key, version: 1, name: key, kind: "PUBLIC", status: "ACTIVE", basePrice: 39, currency: "USD", includedAiUnits: 750 },
    });
    planIds.push(plan.id);
    const e = await prisma.billableEntity.create({ data: { displayName: key } });
    entityIds.push(e.id);
    await prisma.billableEntityTenant.create({ data: { billableEntityId: e.id, tenantId: t.id } });
    await prisma.subscription.create({
      data: { billableEntityId: e.id, planKey: key, planVersion: 1, status: "ACTIVE", currentPeriodEnd: ago(1) },
    });

    await expireDuePocs();

    const sub = await prisma.subscription.findUnique({ where: { billableEntityId: e.id } });
    expect(sub!.status).toBe("ACTIVE");
  });
});

describe("the estate audit", () => {
  it("groups a no-plan tenant as MISSING and offers a decision, not a fix", async () => {
    const t = await makeTenant("ACTIVE");
    const report = await auditTenantPlans();
    const row = report.groups.MISSING.find((r) => r.tenantId === t.id);
    expect(row).toBeTruthy();
    expect(row!.verdict.needsReview).toBe(true);
    // Never "assign the default plan": that would invent a commercial
    // agreement. The operator picks.
    expect(row!.actions).toContain("ASSIGN_PAID_PLAN");
    expect(row!.actions).toContain("PROVISION_POC");
    expect(report.requiresReview.some((r) => r.tenantId === t.id)).toBe(true);
  });

  it("places an active POC tenant in the POC group", async () => {
    const t = await makeTenant("ACTIVE");
    await provisionPoc({ tenantId: t.id, credits: 1_000, expiresAt: ahead(240), features: ["conversation"] });
    const report = await auditTenantPlans();
    expect(report.groups.ACTIVE_POC.some((r) => r.tenantId === t.id)).toBe(true);
  });

  it("accounts for every tenant it reports", async () => {
    const report = await auditTenantPlans();
    const grouped = Object.values(report.groups).reduce((n, rows) => n + rows.length, 0);
    expect(grouped).toBe(report.total);
  });
});
