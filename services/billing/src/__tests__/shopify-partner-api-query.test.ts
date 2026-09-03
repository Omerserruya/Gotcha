/**
 * The Partner API query, pinned against the schema it actually runs on.
 *
 * WHAT WENT WRONG
 * ---------------
 * The query asked for `id` and `status`. Neither field exists on
 * `ActiveSubscription`. It had been written from documentation and never
 * executed against the real API, so nothing failed until the first merchant
 * approved a plan - at which point verification returned
 *
 *   Field 'id' doesn't exist on type 'ActiveSubscription'
 *   Field 'status' doesn't exist on type 'ActiveSubscription'
 *
 * and the merchant, who had genuinely paid, was told we could not confirm it.
 *
 * The capability table already said `verifySubscription: "unverified"`. That
 * honesty was correct and useless - it recorded the risk without preventing
 * it. These tests convert it into something that fails in CI.
 *
 * The field list below is from LIVE introspection of the Partner API
 * (2026-07), not from docs. If Shopify changes the type, this file is where
 * that shows up.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deriveStatus, ACTIVE_SUBSCRIPTION_FIELDS } from "../billing-sources/shopify/partner-api.client";

/** Introspected from the live Partner API on 2026-09-03. */
const REAL_ACTIVE_SUBSCRIPTION_FIELDS = new Set([
  "app",
  "billingPeriod",
  "cancelAtEndOfCycle",
  "currentBillingCycle",
  "items",
  "legacySubscriptionId",
  "pendingUpdate",
  "shop",
  "trialEndsAt",
]);

/** Introspected sub-types. */
const REAL_BILLING_CYCLE_FIELDS = new Set(["startTime", "endTime"]);
const REAL_SUBSCRIPTION_ITEM_FIELDS = new Set([
  "description",
  "discount",
  "handle",
  "price",
  "usage",
]);

const SOURCE = readFileSync(
  join(__dirname, "../billing-sources/shopify/partner-api.client.ts"),
  "utf8",
);

/** The GraphQL document, extracted from the module rather than re-typed. */
function queryText(): string {
  const m = SOURCE.match(/const ACTIVE_SUBSCRIPTION_QUERY = `([\s\S]*?)`;/);
  if (!m) throw new Error("ACTIVE_SUBSCRIPTION_QUERY not found");
  return m[1];
}

describe("the query only names fields the schema has", () => {
  it("every declared field exists on ActiveSubscription", () => {
    for (const f of ACTIVE_SUBSCRIPTION_FIELDS) {
      expect(REAL_ACTIVE_SUBSCRIPTION_FIELDS.has(f)).toBe(true);
    }
  });

  it("the declared list matches what the query actually selects", () => {
    // The two drifting apart is the failure this guards: a field added to the
    // query but not the list would be unchecked.
    const q = queryText();
    for (const f of ACTIVE_SUBSCRIPTION_FIELDS) {
      expect(q).toMatch(new RegExp(`\\b${f}\\b`));
    }
  });

  it("does NOT ask for `id` - the regression that broke production", () => {
    const q = queryText();
    // `legacySubscriptionId` legitimately contains "Id"; the bare selection is
    // what must be absent.
    expect(q).not.toMatch(/^\s*id\s*$/m);
  });

  it("does NOT ask for `status` - the field that does not exist", () => {
    expect(queryText()).not.toMatch(/^\s*status\s*$/m);
  });

  it("sub-selections are valid too", () => {
    const q = queryText();
    const cycle = q.match(/currentBillingCycle\s*\{([^}]*)\}/);
    expect(cycle).toBeTruthy();
    for (const f of cycle![1].trim().split(/\s+/)) {
      expect(REAL_BILLING_CYCLE_FIELDS.has(f)).toBe(true);
    }
    const items = q.match(/items\s*\{([^}]*)\}/);
    expect(items).toBeTruthy();
    for (const f of items![1].trim().split(/\s+/)) {
      expect(REAL_SUBSCRIPTION_ITEM_FIELDS.has(f)).toBe(true);
    }
  });

  it("uses the shopify GID namespace, not partners", () => {
    // `app(id:)` tolerates `gid://partners/...`; `activeSubscription` rejects
    // it with INVALID_GID. One namespace, so the difference cannot bite.
    expect(SOURCE).toMatch(/gid:\/\/shopify\/Shop\//);
    expect(SOURCE).toMatch(/gid:\/\/shopify\/App\//);
    expect(SOURCE).not.toMatch(/gid:\/\/partners\//);
  });
});

describe("status is derived, because the API sends none", () => {
  const now = new Date("2026-09-03T12:00:00Z");

  it("a future trial end means TRIALING", () => {
    expect(deriveStatus(new Date("2026-09-17T12:15:08Z"), now)).toBe("TRIALING");
  });

  it("no trial means ACTIVE", () => {
    expect(deriveStatus(null, now)).toBe("ACTIVE");
  });

  it("a past trial end means ACTIVE, not expired", () => {
    // The subscription is still returned by `activeSubscription`, so it is
    // live - the trial simply ended and billing began. Reading this as
    // "expired" would revoke a paying merchant.
    expect(deriveStatus(new Date("2026-08-01T00:00:00Z"), now)).toBe("ACTIVE");
  });

  it("both derived statuses grant access", async () => {
    const { grantsAccess } = await import("../billing-sources/shopify/status-map");
    expect(grantsAccess("ACTIVE")).toBe(true);
    expect(grantsAccess("TRIALING")).toBe(true);
  });
});

describe("the real response shape maps correctly", () => {
  it("the live payload from activewaer resolves to the configured plan", async () => {
    // Captured verbatim from the Partner API for activewaer.myshopify.com
    // after the merchant approved gotcha-connector.
    const live = {
      legacySubscriptionId: "gid://shopify/AppSubscription/40080539962",
      billingPeriod: "EVERY_30_DAYS",
      cancelAtEndOfCycle: false,
      trialEndsAt: "2026-09-17T12:15:08Z",
      currentBillingCycle: null,
      items: [{ handle: "gotcha-connector", description: "GOTCHA Connector" }],
    };

    process.env.SHOPIFY_BILLING_PLAN_CATALOG = JSON.stringify([
      {
        key: "SHOPIFY_CONNECTOR",
        handle: "gotcha-connector",
        entitlements: [
          "shopify_catalog_sync",
          "shopify_order_read",
          "shopify_order_actions",
          "shopify_storefront_widget",
        ],
      },
    ]);

    const { findPlanForSubscription, planEntitlements } = await import(
      "../billing-sources/shopify/plan-catalog"
    );
    const plan = findPlanForSubscription({ handle: live.items[0].handle });
    expect(plan?.key).toBe("SHOPIFY_CONNECTOR");
    // The whole point: this payload must NOT land in UNKNOWN_PLAN.
    expect(planEntitlements(plan!.key)).toHaveLength(4);
    expect(deriveStatus(new Date(live.trialEndsAt), new Date("2026-09-03T12:00:00Z"))).toBe(
      "TRIALING",
    );
    delete process.env.SHOPIFY_BILLING_PLAN_CATALOG;
  });
});
