/**
 * Grandfathering, against the real database.
 *
 * The whole value of this feature is in the cases it REFUSES, so those are
 * tested one at a time rather than implied by a happy path. Two in particular
 * would be invisible in production if they regressed:
 *
 *   • an account created before publication that first paid AFTER it must not
 *     be grandfathered. It looks like an old customer by every lazy measure
 *     (`tenant.createdAt`), and it is a new one commercially.
 *
 *   • a grant must survive a reinstall unchanged. Eligibility is a fact about
 *     the past; re-deciding it on each install would make it depend on which
 *     flags happened to be set that day.
 */
import { describe, it, expect, beforeEach, afterAll, afterEach } from "vitest";
import { prisma } from "@chatcenter/shared";
import {
  assessGrandfatherEligibility,
  ensureGrandfatherGrant,
  overrideGrandfatherGrant,
  revokeGrandfatherGrant,
  getActiveGrandfatherGrant,
} from "../services/shopify-grandfather.service";

const RUN = `gf-${Date.now().toString(36)}`;
const ORIGINAL = { ...process.env };

const tenantIds: string[] = [];
const entityIds: string[] = [];

/** The listing published on 1 June 2026, for every test in this file. */
const CUTOFF = "2026-06-01T00:00:00.000Z";
const BEFORE = new Date("2026-03-15T00:00:00.000Z");
const AFTER = new Date("2026-08-20T00:00:00.000Z");

function enable(opts: { cutoff?: string | null; devStores?: boolean } = {}) {
  process.env.SHOPIFY_BILLING_ENABLED = "true";
  process.env.SHOPIFY_BILLING_MODE = "manual";
  process.env.SHOPIFY_ALLOW_GRANDFATHERED = "true";
  const cutoff = opts.cutoff === undefined ? CUTOFF : opts.cutoff;
  if (cutoff) process.env.SHOPIFY_APP_PUBLICATION_CUTOFF = cutoff;
  if (opts.devStores) process.env.SHOPIFY_GRANDFATHER_DEV_STORES = "true";
}

interface TenantOpts {
  /** When the WORKSPACE was created. Deliberately variable and never decisive. */
  createdAt?: Date;
  subscriptionStatus?: "ACTIVE" | "TRIALING" | "CANCELED" | "PENDING";
  /** When a real payment landed, if one did. */
  invoicePaidAt?: Date | null;
  /** When the subscription first went live, if it did. */
  activatedAt?: Date | null;
  subscriptionCreatedAt?: Date;
  billingSource?: "GOTCHA_EXTERNAL" | "SHOPIFY";
}

async function newTenant(opts: TenantOpts = {}) {
  const n = `${RUN}-${Math.random().toString(36).slice(2, 8)}`;
  const tenant = await prisma.tenant.create({
    data: {
      name: n,
      slug: n,
      status: "ACTIVE",
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    },
  });
  tenantIds.push(tenant.id);

  const entity = await prisma.billableEntity.create({ data: { displayName: n } });
  entityIds.push(entity.id);
  await prisma.billableEntityTenant.create({
    data: { billableEntityId: entity.id, tenantId: tenant.id },
  });

  let subscriptionId: string | null = null;
  if (opts.subscriptionStatus) {
    const sub = await prisma.subscription.create({
      data: {
        billableEntityId: entity.id,
        planKey: "ai_workforce",
        planVersion: 1,
        status: opts.subscriptionStatus,
        billingSource: opts.billingSource ?? "GOTCHA_EXTERNAL",
        ...(opts.subscriptionCreatedAt ? { createdAt: opts.subscriptionCreatedAt } : {}),
      },
    });
    subscriptionId = sub.id;

    if (opts.activatedAt) {
      await prisma.subscriptionEvent.create({
        data: {
          subscriptionId: sub.id,
          type: "activated",
          toStatus: "ACTIVE",
          at: opts.activatedAt,
          actor: "test",
        },
      });
    }
  }

  if (opts.invoicePaidAt) {
    await prisma.invoice.create({
      data: {
        billableEntityId: entity.id,
        type: "SUBSCRIPTION",
        status: "PAID",
        paidAt: opts.invoicePaidAt,
        currency: "ILS",
        amount: 100,
      },
    });
  }

  return { tenant, entityId: entity.id, subscriptionId };
}

beforeEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("SHOPIFY_")) delete process.env[k];
  }
});

afterEach(async () => {
  await prisma.shopifyGrandfatherGrant.deleteMany({ where: { tenantId: { in: tenantIds } } });
});

afterAll(async () => {
  process.env = { ...ORIGINAL };
  await prisma.invoice.deleteMany({ where: { billableEntityId: { in: entityIds } } });
  await prisma.subscriptionEvent.deleteMany({
    where: { subscription: { billableEntityId: { in: entityIds } } },
  });
  await prisma.subscription.deleteMany({ where: { billableEntityId: { in: entityIds } } });
  await prisma.billableEntityTenant.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.billableEntity.deleteMany({ where: { id: { in: entityIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
});

// ─── Scenario 1 ──────────────────────────────────────────────────────────

describe("scenario 1: paying before publication", () => {
  it("is eligible, on the strength of a paid invoice", async () => {
    enable();
    const { tenant } = await newTenant({
      subscriptionStatus: "ACTIVE",
      invoicePaidAt: BEFORE,
    });

    const a = await assessGrandfatherEligibility({ tenantId: tenant.id });
    expect(a.eligible).toBe(true);
    expect(a.reason).toBe("paid_before_publication_cutoff");
    expect(a.paidSinceEvidence).toBe("invoice_paid_at");
    // Strongest evidence available, so the claim is CONFIRMED rather than
    // inferred - this is the row an auditor would want to land on.
    expect(a.evidenceQuality).toBe("CONFIRMED");
  });

  it("records the grant with the evidence that produced it", async () => {
    enable();
    const { tenant } = await newTenant({ subscriptionStatus: "ACTIVE", invoicePaidAt: BEFORE });

    const r = await ensureGrandfatherGrant({ tenantId: tenant.id });
    expect(r.created).toBe(true);
    expect(r.grant?.source).toBe("AUTOMATIC");
    expect(r.grant?.paidSince?.toISOString()).toBe(BEFORE.toISOString());
    // The cutoff is stored, not just read: the configured value can move, and
    // the grant has to stay explainable against the rule that made it.
    expect(r.grant?.cutoffAt?.toISOString()).toBe(CUTOFF);
  });
});

// ─── Scenario 2 - the one that would be invisible ────────────────────────

describe("scenario 2: created before publication, first paid after", () => {
  it("is NOT grandfathered, even though the ACCOUNT is old", async () => {
    enable();
    const { tenant } = await newTenant({
      // Account opened well before the listing...
      createdAt: new Date("2026-01-05T00:00:00.000Z"),
      subscriptionStatus: "ACTIVE",
      // ...but the money only arrived afterwards.
      invoicePaidAt: AFTER,
      subscriptionCreatedAt: AFTER,
    });

    const a = await assessGrandfatherEligibility({ tenantId: tenant.id });
    expect(a.eligible).toBe(false);
    expect(a.reason).toBe("first_paid_after_publication_cutoff");
    // The account date is recorded as context, and demonstrably did not decide
    // it - this assertion is what stops a future refactor reaching for it.
    expect(a.evidence.accountCreatedAt).toBe("2026-01-05T00:00:00.000Z");
  });

  it("leaves no grant behind", async () => {
    enable();
    const { tenant } = await newTenant({
      createdAt: new Date("2026-01-05T00:00:00.000Z"),
      subscriptionStatus: "ACTIVE",
      invoicePaidAt: AFTER,
    });
    const r = await ensureGrandfatherGrant({ tenantId: tenant.id });
    expect(r.grant).toBeNull();
    expect(await getActiveGrandfatherGrant(tenant.id)).toBeNull();
  });
});

// ─── Scenario 3 ──────────────────────────────────────────────────────────

describe("scenario 3: a new external customer after publication", () => {
  it("is not grandfathered and must pay Shopify", async () => {
    enable();
    const { tenant } = await newTenant({
      createdAt: AFTER,
      subscriptionStatus: "ACTIVE",
      invoicePaidAt: AFTER,
    });
    const a = await assessGrandfatherEligibility({ tenantId: tenant.id });
    expect(a.eligible).toBe(false);
    expect(a.reason).toBe("first_paid_after_publication_cutoff");
  });
});

// ─── Scenario 4 ──────────────────────────────────────────────────────────

describe("scenario 4: an App Store install with no prior GOTCHA relationship", () => {
  it("has no subscription to grandfather", async () => {
    enable();
    const { tenant } = await newTenant();
    const a = await assessGrandfatherEligibility({ tenantId: tenant.id });
    expect(a.eligible).toBe(false);
    expect(a.reason).toBe("no_gotcha_subscription");
  });

  it("a subscription that never paid is not evidence", async () => {
    enable();
    // PENDING: created, card not on file, nothing ever charged.
    const { tenant } = await newTenant({ subscriptionStatus: "PENDING" });
    const a = await assessGrandfatherEligibility({ tenantId: tenant.id });
    expect(a.eligible).toBe(false);
    expect(a.reason).toBe("no_evidence_of_payment");
  });
});

// ─── Evidence ladder ─────────────────────────────────────────────────────

describe("the evidence ladder, strongest first", () => {
  it("prefers a paid invoice over the activation event", async () => {
    enable();
    const { tenant } = await newTenant({
      subscriptionStatus: "ACTIVE",
      invoicePaidAt: new Date("2026-02-01T00:00:00.000Z"),
      activatedAt: new Date("2026-04-01T00:00:00.000Z"),
    });
    const a = await assessGrandfatherEligibility({ tenantId: tenant.id });
    expect(a.paidSinceEvidence).toBe("invoice_paid_at");
    expect(a.paidSince?.toISOString()).toBe("2026-02-01T00:00:00.000Z");
  });

  it("falls back to the activation event when no invoice was paid", async () => {
    enable();
    const { tenant } = await newTenant({ subscriptionStatus: "ACTIVE", activatedAt: BEFORE });
    const a = await assessGrandfatherEligibility({ tenantId: tenant.id });
    expect(a.paidSinceEvidence).toBe("subscription_activated_event");
    expect(a.eligible).toBe(true);
  });

  it("uses subscription creation only as a last resort, and says the claim is weaker", async () => {
    enable();
    const { tenant } = await newTenant({
      subscriptionStatus: "ACTIVE",
      subscriptionCreatedAt: BEFORE,
    });
    const a = await assessGrandfatherEligibility({ tenantId: tenant.id });
    expect(a.paidSinceEvidence).toBe("subscription_created_at");
    expect(a.eligible).toBe(true);
    // Weakest evidence, so the row says INFERRED. A reviewer can find every
    // decision that rested on it with one WHERE clause.
    expect(a.evidenceQuality).toBe("INFERRED");
  });
});

// ─── Refusals that protect the default ───────────────────────────────────

describe("the switches, and what happens when they are off", () => {
  it("refuses when grandfathering is not permitted", async () => {
    process.env.SHOPIFY_BILLING_ENABLED = "true";
    process.env.SHOPIFY_BILLING_MODE = "manual";
    process.env.SHOPIFY_APP_PUBLICATION_CUTOFF = CUTOFF;
    // SHOPIFY_ALLOW_GRANDFATHERED deliberately unset.
    const { tenant } = await newTenant({ subscriptionStatus: "ACTIVE", invoicePaidAt: BEFORE });
    const a = await assessGrandfatherEligibility({ tenantId: tenant.id });
    expect(a.eligible).toBe(false);
    expect(a.reason).toBe("grandfathering_not_permitted");
  });

  it("an unset cutoff grandfathers NOBODY", async () => {
    // The fail-closed direction. A missing publication date must not mean
    // "everyone qualifies" - that would hand out free access to the entire
    // customer base on a configuration omission.
    enable({ cutoff: null });
    const { tenant } = await newTenant({ subscriptionStatus: "ACTIVE", invoicePaidAt: BEFORE });
    const a = await assessGrandfatherEligibility({ tenantId: tenant.id });
    expect(a.eligible).toBe(false);
    expect(a.reason).toBe("publication_cutoff_not_configured");
    expect(a.evidenceQuality).toBe("REVIEW_REQUIRED");
  });

  it("a malformed cutoff is treated as unset, not as epoch", async () => {
    // `new Date("not a date")` is Invalid Date; comparing against it would make
    // every comparison false in a way that reads as a deliberate refusal.
    enable({ cutoff: "not-a-date" });
    const { tenant } = await newTenant({ subscriptionStatus: "ACTIVE", invoicePaidAt: BEFORE });
    const a = await assessGrandfatherEligibility({ tenantId: tenant.id });
    expect(a.reason).toBe("publication_cutoff_not_configured");
  });

  it("a subscription already billed by Shopify is not grandfathered", async () => {
    enable();
    const { tenant } = await newTenant({
      subscriptionStatus: "ACTIVE",
      invoicePaidAt: BEFORE,
      billingSource: "SHOPIFY",
    });
    const a = await assessGrandfatherEligibility({ tenantId: tenant.id });
    expect(a.eligible).toBe(false);
    expect(a.reason).toBe("subscription_not_externally_billed");
  });
});

// ─── Scenario 17 ─────────────────────────────────────────────────────────

describe("scenario 17: development stores", () => {
  it("are not grandfathered automatically", async () => {
    enable();
    const { tenant } = await newTenant({ subscriptionStatus: "ACTIVE", invoicePaidAt: BEFORE });
    const a = await assessGrandfatherEligibility({
      tenantId: tenant.id,
      isDevelopmentStore: true,
    });
    expect(a.eligible).toBe(false);
    expect(a.reason).toBe("development_store_not_auto_grandfathered");
  });

  it("are grandfathered when a deployment opts in explicitly", async () => {
    enable({ devStores: true });
    const { tenant } = await newTenant({ subscriptionStatus: "ACTIVE", invoicePaidAt: BEFORE });
    const a = await assessGrandfatherEligibility({
      tenantId: tenant.id,
      isDevelopmentStore: true,
    });
    expect(a.eligible).toBe(true);
  });

  it("an unknown store type is treated as a real store", async () => {
    // Refusing every unknown would block real merchants whenever the shop read
    // failed, which is the more damaging error of the two.
    enable();
    const { tenant } = await newTenant({ subscriptionStatus: "ACTIVE", invoicePaidAt: BEFORE });
    const a = await assessGrandfatherEligibility({ tenantId: tenant.id });
    expect(a.eligible).toBe(true);
  });
});

// ─── Scenario 12: reinstall, and idempotence ─────────────────────────────

describe("scenario 12: idempotence across reinstalls", () => {
  it("a second evaluation returns the SAME grant and creates nothing", async () => {
    enable();
    const { tenant } = await newTenant({ subscriptionStatus: "ACTIVE", invoicePaidAt: BEFORE });

    const first = await ensureGrandfatherGrant({ tenantId: tenant.id });
    const second = await ensureGrandfatherGrant({ tenantId: tenant.id });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.reason).toBe("existing_grant");
    expect(second.grant?.id).toBe(first.grant?.id);

    const all = await prisma.shopifyGrandfatherGrant.findMany({ where: { tenantId: tenant.id } });
    expect(all).toHaveLength(1);
  });

  it("a standing grant survives the flag being switched off afterwards", async () => {
    // Eligibility is a fact about the past. Re-deciding it against today's
    // flags is exactly what a reinstall must not do.
    enable();
    const { tenant } = await newTenant({ subscriptionStatus: "ACTIVE", invoicePaidAt: BEFORE });
    await ensureGrandfatherGrant({ tenantId: tenant.id });

    delete process.env.SHOPIFY_ALLOW_GRANDFATHERED;
    const again = await ensureGrandfatherGrant({ tenantId: tenant.id });
    expect(again.grant).not.toBeNull();
    expect(again.reason).toBe("existing_grant");
  });

  it("a REVOKED grant is not silently re-granted on reinstall", async () => {
    enable();
    const { tenant } = await newTenant({ subscriptionStatus: "ACTIVE", invoicePaidAt: BEFORE });
    await ensureGrandfatherGrant({ tenantId: tenant.id });
    await revokeGrandfatherGrant({
      tenantId: tenant.id,
      revokedBy: "admin-1",
      reason: "commercial decision",
    });

    const again = await ensureGrandfatherGrant({ tenantId: tenant.id });
    expect(again.grant).toBeNull();
    expect(again.reason).toBe("grant_revoked");
  });
});

// ─── Scenario 18: the admin override ─────────────────────────────────────

describe("scenario 18: internal admin override", () => {
  it("grants access the rules would have refused, and records who did it", async () => {
    enable();
    // Deliberately ineligible: first paid after the cutoff.
    const { tenant } = await newTenant({ subscriptionStatus: "ACTIVE", invoicePaidAt: AFTER });

    const grant = await overrideGrandfatherGrant({
      tenantId: tenant.id,
      approvedBy: "admin-42",
      note: "migrated contract, invoiced outside the system",
    });

    expect(grant.source).toBe("ADMIN_OVERRIDE");
    expect(grant.approvedBy).toBe("admin-42");
    // A human decision is not evidence about the past, and must not be able to
    // hide among the rows that are.
    expect(grant.evidenceQuality).toBe("REVIEW_REQUIRED");
  });

  it("stores what the automatic rules concluded, even though it overrode them", async () => {
    enable();
    const { tenant } = await newTenant({ subscriptionStatus: "ACTIVE", invoicePaidAt: AFTER });
    const grant = await overrideGrandfatherGrant({ tenantId: tenant.id, approvedBy: "admin-42" });
    const evidence = grant.evidence as any;
    expect(evidence.automaticAssessment.eligible).toBe(false);
    expect(evidence.automaticAssessment.reason).toBe("first_paid_after_publication_cutoff");
  });

  it("refuses an override with nobody attached to it", async () => {
    enable();
    const { tenant } = await newTenant();
    await expect(
      overrideGrandfatherGrant({ tenantId: tenant.id, approvedBy: "  " }),
    ).rejects.toThrow(/attributable/);
  });

  it("re-granting after a revocation clears the revocation columns", async () => {
    enable();
    const { tenant } = await newTenant({ subscriptionStatus: "ACTIVE", invoicePaidAt: BEFORE });
    await ensureGrandfatherGrant({ tenantId: tenant.id });
    await revokeGrandfatherGrant({ tenantId: tenant.id, revokedBy: "admin-1", reason: "x" });

    const grant = await overrideGrandfatherGrant({ tenantId: tenant.id, approvedBy: "admin-2" });
    expect(grant.status).toBe("ACTIVE");
    // A live grant carrying a stale revocation would read as revoked to anyone
    // querying the audit columns rather than the status.
    expect(grant.revokedAt).toBeNull();
    expect(grant.revokedBy).toBeNull();
  });

  it("revocation is attributable too", async () => {
    enable();
    const { tenant } = await newTenant({ subscriptionStatus: "ACTIVE", invoicePaidAt: BEFORE });
    await ensureGrandfatherGrant({ tenantId: tenant.id });
    await expect(
      revokeGrandfatherGrant({ tenantId: tenant.id, revokedBy: "", reason: "x" }),
    ).rejects.toThrow(/attributable/);
  });
});
