/**
 * The policy resolver, against the real database.
 *
 * The cases that matter are the refusals. A resolver that answers FULL_SHOPIFY
 * when it should have said "I do not know" sends a merchant to a payment page
 * they may not owe; one that answers GRANDFATHERED_EXTERNAL without evidence
 * hands out paid access forever. Both look like success from the outside,
 * which is why they are tested one at a time rather than implied by a
 * happy-path run.
 */
import { describe, it, expect, beforeEach, afterAll, afterEach } from "vitest";
import { prisma } from "@chatcenter/shared";
import {
  decideBillingPolicy,
  resolveAndRecordBillingPolicy,
  latestBillingPolicyDecision,
} from "../services/billing-policy-resolver.service";

const RUN = `pol-${Date.now().toString(36)}`;
const ORIGINAL = { ...process.env };

const tenantIds: string[] = [];
const entityIds: string[] = [];

function enableShopify(opts: {
  policy?: "full" | "connector_addon" | "grandfathered_only";
  split?: boolean;
  grandfathered?: boolean;
} = {}) {
  process.env.SHOPIFY_BILLING_ENABLED = "true";
  process.env.SHOPIFY_BILLING_MODE = "manual";
  if (opts.policy) process.env.SHOPIFY_BILLING_POLICY_MODE = opts.policy;
  if (opts.split) process.env.SHOPIFY_ALLOW_SPLIT_BILLING = "true";
  if (opts.grandfathered) process.env.SHOPIFY_ALLOW_GRANDFATHERED = "true";
}

/** A workspace, optionally already paying GOTCHA directly. */
async function newTenant(opts: { withExternalSub?: "ACTIVE" | "CANCELED" | "PENDING" } = {}) {
  const n = `${RUN}-${Math.random().toString(36).slice(2, 8)}`;
  const tenant = await prisma.tenant.create({ data: { name: n, slug: n, status: "ACTIVE" } });
  tenantIds.push(tenant.id);
  const entity = await prisma.billableEntity.create({ data: { displayName: n } });
  entityIds.push(entity.id);
  await prisma.billableEntityTenant.create({
    data: { billableEntityId: entity.id, tenantId: tenant.id },
  });
  if (opts.withExternalSub) {
    await prisma.subscription.create({
      data: {
        billableEntityId: entity.id,
        planKey: "ai_workforce",
        planVersion: 1,
        status: opts.withExternalSub,
        billingSource: "GOTCHA_EXTERNAL",
      },
    });
  }
  return { tenant, entityId: entity.id };
}

beforeEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("SHOPIFY_")) delete process.env[k];
  }
});

afterEach(async () => {
  await prisma.billingPolicyDecision.deleteMany({ where: { tenantId: { in: tenantIds } } });
});

afterAll(async () => {
  process.env = { ...ORIGINAL };
  await prisma.subscription.deleteMany({ where: { billableEntityId: { in: entityIds } } });
  await prisma.billableEntityTenant.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.billableEntity.deleteMany({ where: { id: { in: entityIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
});

describe("a disabled or unconfigured integration never guesses", () => {
  it("scenario 22: flags off => UNRESOLVED, and nobody is sent to pay", async () => {
    const { tenant } = await newTenant();
    const d = await decideBillingPolicy({ tenantId: tenant.id });
    expect(d.policy).toBe("UNRESOLVED");
    expect(d.reason).toBe("shopify_billing_disabled");
    expect(d.requiresShopifyPlanSelection).toBe(false);
    expect(d.grandfathered).toBe(false);
  });

  it("enabled but with no mode is still UNRESOLVED", async () => {
    const { tenant } = await newTenant();
    process.env.SHOPIFY_BILLING_ENABLED = "true";
    const d = await decideBillingPolicy({ tenantId: tenant.id });
    expect(d.reason).toBe("shopify_billing_mode_unset");
  });

  it("a mode with no POLICY mode is still UNRESOLVED", async () => {
    const { tenant } = await newTenant();
    enableShopify();
    const d = await decideBillingPolicy({ tenantId: tenant.id });
    expect(d.reason).toBe("policy_mode_unset");
  });

  it("an unknown tenant is REVIEW_REQUIRED, not a quiet no", async () => {
    enableShopify({ policy: "full" });
    const d = await decideBillingPolicy({ tenantId: "does-not-exist" });
    expect(d.policy).toBe("UNRESOLVED");
    expect(d.evidenceQuality).toBe("REVIEW_REQUIRED");
  });
});

describe("grandfathering needs a switch AND evidence", () => {
  it("scenario 4: an ACTIVE external subscription plus the switch qualifies", async () => {
    const { tenant } = await newTenant({ withExternalSub: "ACTIVE" });
    enableShopify({ policy: "grandfathered_only", grandfathered: true });
    const d = await decideBillingPolicy({ tenantId: tenant.id });
    expect(d.policy).toBe("GRANDFATHERED_EXTERNAL");
    expect(d.grandfathered).toBe(true);
    // CONFIRMED because it rests on a row in our own database.
    expect(d.evidenceQuality).toBe("CONFIRMED");
    // No Shopify subscription is created for a grandfathered customer.
    expect(d.requiresShopifyPlanSelection).toBe(false);
  });

  it("the switch alone, with no qualifying subscription, does NOT grandfather", async () => {
    const { tenant } = await newTenant(); // no subscription at all
    enableShopify({ policy: "grandfathered_only", grandfathered: true });
    const d = await decideBillingPolicy({ tenantId: tenant.id });
    expect(d.policy).toBe("UNRESOLVED");
    expect(d.reason).toBe("grandfathering_requested_without_evidence");
    expect(d.grandfathered).toBe(false);
    // The absence of evidence is recorded AS an absence, for a human to look at.
    expect(d.evidenceQuality).toBe("REVIEW_REQUIRED");
  });

  it("a CANCELED subscription is not evidence of anything", async () => {
    const { tenant } = await newTenant({ withExternalSub: "CANCELED" });
    enableShopify({ policy: "grandfathered_only", grandfathered: true });
    const d = await decideBillingPolicy({ tenantId: tenant.id });
    expect(d.grandfathered).toBe(false);
    expect(d.reason).toBe("grandfathering_requested_without_evidence");
  });

  it("a PENDING subscription - created, never paid - is not evidence either", async () => {
    const { tenant } = await newTenant({ withExternalSub: "PENDING" });
    enableShopify({ policy: "grandfathered_only", grandfathered: true });
    const d = await decideBillingPolicy({ tenantId: tenant.id });
    expect(d.grandfathered).toBe(false);
  });

  it("evidence without the switch refuses rather than grandfathering", async () => {
    const { tenant } = await newTenant({ withExternalSub: "ACTIVE" });
    enableShopify({ policy: "grandfathered_only" }); // switch NOT set
    const d = await decideBillingPolicy({ tenantId: tenant.id });
    expect(d.policy).toBe("UNRESOLVED");
    expect(d.reason).toBe("grandfathering_not_permitted");
  });
});

describe("connector add-on is split billing, and says so", () => {
  it("scenario 2/3: with split billing allowed, Core stays external", async () => {
    const { tenant } = await newTenant({ withExternalSub: "ACTIVE" });
    enableShopify({ policy: "connector_addon", split: true });
    const d = await decideBillingPolicy({ tenantId: tenant.id });
    expect(d.policy).toBe("SHOPIFY_CONNECTOR_ADDON");
    expect(d.reason).toBe("external_core_retained_shopify_bills_connector");
    expect(d.requiresShopifyPlanSelection).toBe(true);
    expect(d.requiresMigrationReview).toBe(false);
  });

  it("scenario 23: without split billing allowed it REFUSES - the double-charge guard", async () => {
    const { tenant } = await newTenant({ withExternalSub: "ACTIVE" });
    enableShopify({ policy: "connector_addon" }); // split NOT allowed
    const d = await decideBillingPolicy({ tenantId: tenant.id });
    expect(d.policy).toBe("UNRESOLVED");
    expect(d.reason).toBe("split_billing_not_permitted");
    expect(d.requiresShopifyPlanSelection).toBe(false);
  });

  it("works for a workspace with no external subscription at all", async () => {
    const { tenant } = await newTenant();
    enableShopify({ policy: "connector_addon", split: true });
    const d = await decideBillingPolicy({ tenantId: tenant.id });
    expect(d.policy).toBe("SHOPIFY_CONNECTOR_ADDON");
    expect(d.reason).toBe("no_external_subscription_shopify_bills_connector");
  });
});

describe("full Shopify records what it does NOT do", () => {
  it("scenario 5: a brand-new merchant goes to plan selection", async () => {
    const { tenant } = await newTenant();
    enableShopify({ policy: "full" });
    const d = await decideBillingPolicy({ tenantId: tenant.id, acquisitionSource: "app_store" });
    expect(d.policy).toBe("FULL_SHOPIFY");
    expect(d.requiresShopifyPlanSelection).toBe(true);
    expect(d.requiresMigrationReview).toBe(false);
  });

  it("an existing paying customer flags migration review and cancels NOTHING", async () => {
    const { tenant, entityId } = await newTenant({ withExternalSub: "ACTIVE" });
    enableShopify({ policy: "full" });
    const d = await decideBillingPolicy({ tenantId: tenant.id });
    expect(d.policy).toBe("FULL_SHOPIFY");
    expect(d.requiresMigrationReview).toBe(true);

    // The external subscription is untouched. Automatic cancellation is
    // exactly what this branch must not do.
    const sub = await prisma.subscription.findUnique({ where: { billableEntityId: entityId } });
    expect(sub!.status).toBe("ACTIVE");
    expect(sub!.billingSource).toBe("GOTCHA_EXTERNAL");
  });
});

describe("the decision is written down with what it rested on", () => {
  it("persists policy, evidence, quality and BOTH versions", async () => {
    const { tenant } = await newTenant({ withExternalSub: "ACTIVE" });
    enableShopify({ policy: "grandfathered_only", grandfathered: true });
    const d = await resolveAndRecordBillingPolicy({
      tenantId: tenant.id,
      acquisitionSource: "in_app_connect",
      decidedBy: "test",
    });

    const row = await latestBillingPolicyDecision(tenant.id);
    expect(row).toBeTruthy();
    expect(row!.id).toBe(d.decisionId);
    expect(row!.policy).toBe("GRANDFATHERED_EXTERNAL");
    expect(row!.grandfathered).toBe(true);
    expect(row!.evidenceQuality).toBe("CONFIRMED");
    expect(row!.acquisitionSource).toBe("in_app_connect");
    expect(row!.accountCreatedAt).toBeTruthy();
    expect(row!.codeVersion).toBeTruthy();
    // The configuration is captured so two decisions that differ can be told
    // apart by reading them.
    expect(row!.configVersion).toContain("grandfathered=true");
    expect((row!.evidence as any).hasPayingExternalSubscription).toBe(true);
  });

  it("is append-only: changing a flag produces a second row, not an edit", async () => {
    const { tenant } = await newTenant({ withExternalSub: "ACTIVE" });
    enableShopify({ policy: "full" });
    await resolveAndRecordBillingPolicy({ tenantId: tenant.id });
    enableShopify({ policy: "grandfathered_only", grandfathered: true });
    await resolveAndRecordBillingPolicy({ tenantId: tenant.id });

    const rows = await prisma.billingPolicyDecision.findMany({
      where: { tenantId: tenant.id },
      orderBy: { decidedAt: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].policy).toBe("FULL_SHOPIFY");
    expect(rows[1].policy).toBe("GRANDFATHERED_EXTERNAL");
  });

  it("records a refusal too - the pending cases are the ones worth auditing", async () => {
    const { tenant } = await newTenant();
    const d = await resolveAndRecordBillingPolicy({ tenantId: tenant.id });
    expect(d.policy).toBe("UNRESOLVED");
    const row = await latestBillingPolicyDecision(tenant.id);
    expect(row!.reason).toBe("shopify_billing_disabled");
  });
});

describe("cross-tenant isolation", () => {
  it("scenario 21: one workspace's subscription never decides another's policy", async () => {
    const paying = await newTenant({ withExternalSub: "ACTIVE" });
    const fresh = await newTenant();
    enableShopify({ policy: "grandfathered_only", grandfathered: true });

    expect((await decideBillingPolicy({ tenantId: paying.tenant.id })).grandfathered).toBe(true);
    // The neighbouring workspace qualifies for nothing on its neighbour's evidence.
    expect((await decideBillingPolicy({ tenantId: fresh.tenant.id })).grandfathered).toBe(false);
  });
});
