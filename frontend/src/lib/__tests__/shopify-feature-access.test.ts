/**
 * The integration screens must never claim Shopify access the billing state
 * denies.
 *
 * This is the defect these tests exist for: the Connector banner said
 * "capabilities are off" while the same page showed the store Active, the
 * system toggle on, writeback on, 68 of 68 tools live and green capability
 * chips. Requirement 1.2.1 is precisely about that contradiction, so each case
 * below pins one indicator to `grantsAccess` and fails by name if it drifts.
 */
import { describe, it, expect } from "vitest";
import { presentShopifyFeatureAccess } from "@/lib/shopify-connector-state";
import type { ShopifyBillingSnapshot } from "@/lib/api";

/** A store that finished OAuth and is healthy. Payment varies per test. */
function snapshot(over: Partial<ShopifyBillingSnapshot> = {}): ShopifyBillingSnapshot {
  return {
    core: { subscriptionStatus: "ACTIVE", planKey: "poc", billingSource: "GOTCHA_EXTERNAL" },
    installation: {
      status: "CONNECTED",
      shopDomain: "new-for-test.myshopify.com",
      externalShopId: "1",
      connectionId: "c1",
      installedAt: "2026-09-01T00:00:00.000Z",
      uninstalledAt: null,
    },
    shopify: {
      state: "CANCELLED",
      reason: "provider_status_cancelled",
      planHandle: "gotcha-connector",
      lastVerifiedAt: "2026-09-29T00:00:00.000Z",
    },
    grandfathered: null,
    entitlements: [],
    planSelectionUrl: "https://admin.shopify.com/store/x/charges/gotcha/pricing_plans",
    availablePlanCount: 1,
    requiresPlanSelection: false,
    grantsAccess: false,
    ...over,
  } as ShopifyBillingSnapshot;
}

const installed = { integrationConnected: true };

describe("an installed but unpaid Shopify store", () => {
  const a = presentShopifyFeatureAccess("shopify", snapshot(), installed);

  it("is described as Authorized, never Active", () => {
    expect(a.installationLabelKey).toBe("marketplace.shopifyAccess.authorized");
    expect(a.installationLabelKey).not.toContain("active");
  });

  it("says the Connector is required beside the store", () => {
    expect(a.showConnectorRequired).toBe(true);
  });

  it("keeps the OAuth installation - billing does not revoke authorization", () => {
    expect(a.authorized).toBe(true);
  });

  it("switches every Shopify feature indicator off from ONE verdict", () => {
    // The system toggle, writeback, the tool list and the capability chips all
    // read this single flag, so a new indicator cannot forget to ask.
    expect(a.featuresEnabled).toBe(false);
    expect(a.grantsAccess).toBe(false);
  });

  it("never lets featuresEnabled disagree with the server verdict", () => {
    expect(a.featuresEnabled).toBe(a.grantsAccess);
  });
});

describe("a paid Shopify store", () => {
  const a = presentShopifyFeatureAccess(
    "shopify",
    snapshot({ grantsAccess: true, entitlements: ["shopify_catalog_sync"] }),
    installed,
  );

  it("is Active, with no Connector-required chip", () => {
    expect(a.installationLabelKey).toBe("marketplace.shopifyAccess.active");
    expect(a.showConnectorRequired).toBe(false);
  });

  it("presents features as on", () => {
    expect(a.featuresEnabled).toBe(true);
  });
});

describe("what the gate must NOT touch", () => {
  it("leaves every non-Shopify integration alone", () => {
    for (const slug of ["airtable", "google_calendar", "hubspot", "postgresql"]) {
      const a = presentShopifyFeatureAccess(slug, snapshot(), installed);
      expect(a.applies).toBe(false);
      // An unpaid SHOPIFY subscription must never switch Airtable off.
      expect(a.featuresEnabled).toBe(true);
    }
  });

  it("does not gate on a deployment with no Shopify billing at all", () => {
    // Self-hosted and pre-billing installs never had a Connector; denying them
    // on missing data would break working systems.
    const a = presentShopifyFeatureAccess("shopify", null, installed);
    expect(a.applies).toBe(false);
    expect(a.featuresEnabled).toBe(true);
  });
});

describe("the verdict comes from the server and nowhere else", () => {
  it("an ACTIVE Core plan does not unlock Shopify", () => {
    const a = presentShopifyFeatureAccess(
      "shopify",
      snapshot({ core: { subscriptionStatus: "ACTIVE", planKey: "ai_workforce", billingSource: "GOTCHA_EXTERNAL" } } as any),
      installed,
    );
    expect(a.featuresEnabled).toBe(false);
  });

  it("a healthy CONNECTED installation does not unlock Shopify", () => {
    const a = presentShopifyFeatureAccess("shopify", snapshot(), installed);
    expect(a.authorized).toBe(true);
    expect(a.featuresEnabled).toBe(false);
  });

  it("an uninstalled store is not authorized even if the row says CONNECTED", () => {
    const a = presentShopifyFeatureAccess(
      "shopify",
      snapshot({ installation: { ...snapshot().installation, uninstalledAt: "2026-09-28T00:00:00.000Z" } } as any),
      installed,
    );
    expect(a.authorized).toBe(false);
    expect(a.showConnectorRequired).toBe(false);
  });
});
