/**
 * Paid-tenant provisioning and continuation links.
 *
 * DB-backed: the guarantees under test are database ones - that only a hash is
 * stored, that issuing revokes the previous link atomically, and that
 * provisioning creates a prepared-but-unclaimed attempt.
 */
import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@chatcenter/shared";
import {
  provisionPaidTenant,
  resolveAndValidatePlan,
  assertNoClientSuppliedCommercials,
  ProvisioningRefused,
} from "../services/paid-provisioning.service";
import {
  issueContinuationLink,
  resolveContinuationLink,
  revokeLinksForCheckout,
  activeLinkCount,
  hashToken,
  markLinkUsed,
} from "../services/continuation-link.service";

const RUN = `prov-${Date.now()}`;
const tenantIds: string[] = [];

async function newTenant() {
  const n = `${RUN}-${Math.random().toString(36).slice(2, 8)}`;
  const t = await prisma.tenant.create({ data: { name: n, slug: n, status: "PENDING_PAYMENT" } });
  tenantIds.push(t.id);
  return t;
}

async function activePlan() {
  const p = await prisma.plan.findFirst({ where: { key: "ai_workforce", status: "ACTIVE" } });
  if (!p) throw new Error("seed missing: ai_workforce ACTIVE plan");
  return p;
}

afterAll(async () => {
  const checkouts = await prisma.pendingCheckout.findMany({
    where: { tenantId: { in: tenantIds } }, select: { id: true },
  });
  const ids = checkouts.map((c) => c.id);
  await prisma.paymentContinuationLink.deleteMany({ where: { checkoutId: { in: ids } } });
  await prisma.paymentAttempt.deleteMany({ where: { checkoutId: { in: ids } } });
  await prisma.pendingCheckout.deleteMany({ where: { id: { in: ids } } });
  await prisma.billableEntityTenant.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
});

describe("provisioning creates scaffolding but never a subscription", () => {
  it("1-8. creates entity, checkout, prepared attempt and one link", async () => {
    const tenant = await newTenant();
    const plan = await activePlan();

    const r = await provisionPaidTenant({
      tenantId: tenant.id,
      planVersionId: plan.id,
      chatVolumeOptionKey: null,
      actor: "sysadmin-test",
    });

    expect(r.billableEntityId).toBeTruthy();
    expect(r.checkoutReference).toMatch(/^chk_/);

    const checkout = await prisma.pendingCheckout.findUnique({ where: { id: r.checkoutId } });
    expect(checkout?.status).toBe("PENDING");
    expect(checkout?.trialBehavior).toBe("none"); // pays first, always

    const attempt = await prisma.paymentAttempt.findUnique({ where: { id: r.paymentAttemptId } });
    expect(attempt?.state).toBe("PENDING");
    expect(attempt?.purpose).toBe("SUBSCRIPTION_INITIAL");
    // 8-9: prepared, never claimed, no provider request started.
    expect(attempt?.executionOwner).toBeNull();
    expect(attempt?.executionLeaseExpiresAt).toBeNull();
    expect(attempt?.providerRequestStartedAt).toBeNull();
    expect(attempt?.attemptNumber).toBe(0);

    expect(await activeLinkCount(r.checkoutId)).toBe(1);
  });

  it("6. the snapshot matches canonical pricing, not anything client-sent", async () => {
    const tenant = await newTenant();
    const plan = await activePlan();
    const r = await provisionPaidTenant({ tenantId: tenant.id, planVersionId: plan.id });

    const checkout = await prisma.pendingCheckout.findUnique({ where: { id: r.checkoutId } });
    expect(Number(checkout?.snapshotPrice)).toBe(Number(plan.basePrice));
    expect(checkout?.snapshotCurrency).toBe(plan.currency);
    expect(checkout?.snapshotIncludedCredits).toBe(plan.includedAiUnits);
    // amount and snapshot agree - activation compares them exactly.
    expect(Number(checkout?.amount)).toBe(Number(checkout?.snapshotPrice));
  });

  it("10-12. no subscription, no credits, no entitlements", async () => {
    const tenant = await newTenant();
    const plan = await activePlan();
    const r = await provisionPaidTenant({ tenantId: tenant.id, planVersionId: plan.id });

    const sub = await prisma.subscription.findUnique({ where: { billableEntityId: r.billableEntityId } });
    expect(sub).toBeNull();
    expect(await prisma.aiUnitLot.count({ where: { tenantId: tenant.id } })).toBe(0);
    expect(await prisma.tenantFeature.count({ where: { tenantId: tenant.id } })).toBe(0);
  });
});

describe("plan validation rejects everything unsellable", () => {
  it("13. a retired plan version is rejected", async () => {
    const retired = await prisma.plan.findFirst({ where: { status: "RETIRED" } });
    if (!retired) return; // no retired seed in this database
    await expect(resolveAndValidatePlan({ planVersionId: retired.id })).rejects.toThrow(
      /plan_version_not_active/,
    );
  });

  it("14. an unknown plan version is rejected", async () => {
    await expect(resolveAndValidatePlan({ planVersionId: "does-not-exist" })).rejects.toThrow(
      /plan_version_not_found/,
    );
  });

  it("15-16. a volume option from another plan is rejected", async () => {
    const plan = await activePlan();
    await expect(
      resolveAndValidatePlan({ planVersionId: plan.id, chatVolumeOptionKey: "not_a_real_option" }),
    ).rejects.toThrow(/volume_option_invalid/);
  });

  it("16b. a voice option on a chat-only plan is rejected", async () => {
    const plan = await activePlan();
    if (plan.voiceVolumeEnabled) return;
    await expect(
      resolveAndValidatePlan({ planVersionId: plan.id, voiceVolumeOptionKey: "voice_10" }),
    ).rejects.toThrow(/volume_option_not_enabled/);
  });

  it("17. client-supplied commercial values are REJECTED, not ignored", () => {
    for (const field of ["price", "amount", "currency", "includedCredits", "snapshotPrice"]) {
      expect(() => assertNoClientSuppliedCommercials({ [field]: 1 })).toThrow(
        /client_supplied_commercial_value/,
      );
    }
    expect(() => assertNoClientSuppliedCommercials({ planVersionId: "x" })).not.toThrow();
  });

  it("refusals are typed", async () => {
    await expect(resolveAndValidatePlan({ planVersionId: "nope" })).rejects.toBeInstanceOf(
      ProvisioningRefused,
    );
  });
});

describe("continuation links", () => {
  async function linked() {
    const tenant = await newTenant();
    const plan = await activePlan();
    const r = await provisionPaidTenant({ tenantId: tenant.id, planVersionId: plan.id });
    return { tenant, checkoutId: r.checkoutId, link: r.link };
  }

  it("20. the token has real entropy", async () => {
    const { link } = await linked();
    // 24 random bytes, base64url. Guessing is not a threat model at 2^192.
    expect(link.token).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    const a = await linked();
    expect(a.link.token).not.toBe(link.token);
  });

  it("21-22. only the hash is stored; the raw token is nowhere in the row", async () => {
    const { link, checkoutId } = await linked();
    const row = await prisma.paymentContinuationLink.findUnique({ where: { id: link.id } });
    expect(row?.tokenHash).toBe(hashToken(link.token));
    // The raw token must not appear in ANY column of the persisted record.
    expect(JSON.stringify(row)).not.toContain(link.token);
    void checkoutId;
  });

  it("23-25. the link is tenant-, checkout- and purpose-bound", async () => {
    const { link, tenant, checkoutId } = await linked();
    const row = await prisma.paymentContinuationLink.findUnique({ where: { id: link.id } });
    expect(row?.tenantId).toBe(tenant.id);
    expect(row?.checkoutId).toBe(checkoutId);
    expect(row?.purpose).toBe("PAID_TENANT_ONBOARDING");
  });

  it("26. an expired link fails", async () => {
    const { link } = await linked();
    await prisma.paymentContinuationLink.update({
      where: { id: link.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const res = await resolveContinuationLink(link.token);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("expired");
  });

  it("27. a revoked link fails", async () => {
    const { link, checkoutId } = await linked();
    await revokeLinksForCheckout(checkoutId);
    const res = await resolveContinuationLink(link.token);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("revoked");
  });

  it("28-29. invalid and guessed tokens fail identically, revealing nothing", async () => {
    for (const bad of ["", "short", "x".repeat(40), null, 12345, {}]) {
      const res = await resolveContinuationLink(bad as any);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe("invalid");
    }
  });

  it("30-31. issuing revokes the previous link, leaving exactly one valid", async () => {
    const { link, checkoutId, tenant } = await linked();
    const second = await issueContinuationLink({ checkoutId, tenantId: tenant.id });

    expect(await activeLinkCount(checkoutId)).toBe(1);
    const old = await resolveContinuationLink(link.token);
    expect(old.ok).toBe(false);
    const fresh = await resolveContinuationLink(second.token);
    expect(fresh.ok).toBe(true);
  });

  it("32-33. resending does not create another checkout or attempt", async () => {
    const { checkoutId, tenant } = await linked();
    const before = {
      checkouts: await prisma.pendingCheckout.count({ where: { tenantId: tenant.id } }),
      attempts: await prisma.paymentAttempt.count({ where: { checkoutId } }),
    };
    await issueContinuationLink({ checkoutId, tenantId: tenant.id });
    expect(await prisma.pendingCheckout.count({ where: { tenantId: tenant.id } })).toBe(before.checkouts);
    expect(await prisma.paymentAttempt.count({ where: { checkoutId } })).toBe(before.attempts);
  });

  it("a valid link resolves and can be marked used without consuming it", async () => {
    const { link } = await linked();
    const res = await resolveContinuationLink(link.token);
    expect(res.ok).toBe(true);
    await markLinkUsed(link.id);
    // Multi-use: still valid after first use, because onboarding spans steps.
    expect((await resolveContinuationLink(link.token)).ok).toBe(true);
  });

  it("a link cannot resume a checkout that is already paid", async () => {
    const { link, checkoutId } = await linked();
    await prisma.pendingCheckout.update({ where: { id: checkoutId }, data: { status: "PAID" } });
    const res = await resolveContinuationLink(link.token);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("checkout_not_resumable");
  });

  it("a link grants nothing on its own", async () => {
    const { link, tenant } = await linked();
    await resolveContinuationLink(link.token);
    // Resolving is a read. It activates nothing.
    const t = await prisma.tenant.findUnique({ where: { id: tenant.id } });
    expect(t?.status).toBe("PENDING_PAYMENT");
    expect(await prisma.aiUnitLot.count({ where: { tenantId: tenant.id } })).toBe(0);
    void link;
  });
});
