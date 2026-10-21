/**
 * One gate, five lifecycle states.
 *
 * The earlier gate asked only "is the Connector paid for". That is the wrong
 * question on its own: a merchant who disconnects Shopify inside GOTCHA has
 * removed the credentials, and whether a subscription is still live somewhere
 * does not make the features work. The screen that photographed this showed
 * the old shop domain, Shopify as the active source of truth and green
 * capability chips beside a card that already said Disconnected.
 *
 * Each state below is a real thing that happens to a real merchant.
 */
import { describe, it, expect } from "vitest";
import { presentShopifyFeatureAccess } from "@/lib/shopify-connector-state";
import type { ShopifyBillingSnapshot } from "@/lib/api";

function snap(over: Partial<ShopifyBillingSnapshot> = {}): ShopifyBillingSnapshot {
  return {
    core: { subscriptionStatus: "ACTIVE", planKey: "poc", billingSource: "GOTCHA_EXTERNAL" },
    installation: {
      status: "CONNECTED", shopDomain: "new-for-test.myshopify.com",
      externalShopId: "1", connectionId: "c1",
      installedAt: "2026-09-29T00:00:00.000Z", uninstalledAt: null,
    },
    shopify: { state: "CANCELLED", reason: "provider_status_cancelled", planHandle: "gotcha-connector" },
    grandfathered: null, entitlements: [],
    planSelectionUrl: "https://admin.shopify.com/store/x/charges/gotcha/pricing_plans",
    availablePlanCount: 1, requiresPlanSelection: false, grantsAccess: false,
    ...over,
  } as ShopifyBillingSnapshot;
}

/** Every Shopify liveness claim on every screen reads these two fields. */
function claims(a: ReturnType<typeof presentShopifyFeatureAccess>) {
  return { featuresEnabled: a.featuresEnabled, labelSaysActive: a.installationLabelKey.endsWith(".active") };
}

describe("1. OAuth installed but never paid", () => {
  const a = presentShopifyFeatureAccess("shopify", snap({ shopify: { state: "PLAN_SELECTION_REQUIRED" } as any }), {
    integrationConnected: true,
  });
  it("is Authorized, not Active, and every feature is off", () => {
    expect(claims(a)).toEqual({ featuresEnabled: false, labelSaysActive: false });
    expect(a.installationLabelKey).toBe("marketplace.shopifyAccess.authorized");
    expect(a.showConnectorRequired).toBe(true);
  });
  it("keeps the OAuth grant - not paying is not the same as not authorized", () => {
    expect(a.authorized).toBe(true);
  });
});

describe("2. Connector cancelled", () => {
  const a = presentShopifyFeatureAccess("shopify", snap(), { integrationConnected: true });
  it("switches every feature off", () => {
    expect(claims(a)).toEqual({ featuresEnabled: false, labelSaysActive: false });
  });
});

describe("3. disconnected inside GOTCHA", () => {
  // The photographed case. Credentials are gone; billing is irrelevant.
  const a = presentShopifyFeatureAccess("shopify", snap(), { integrationConnected: false });

  it("reads Disconnected, not Authorized and not Active", () => {
    expect(a.installationLabelKey).toBe("marketplace.shopifyAccess.disconnected");
    expect(claims(a).labelSaysActive).toBe(false);
  });

  it("switches every feature off", () => {
    expect(a.featuresEnabled).toBe(false);
  });

  it("does not ask for a Connector - the answer is reconnect, not pay", () => {
    expect(a.showConnectorRequired).toBe(false);
  });

  it("closes even when billing still reports a PAID subscription", () => {
    // The dangerous ordering: subscription live, credentials gone. Asking only
    // "is it paid" would have shown this as fully active.
    const paidButDisconnected = presentShopifyFeatureAccess(
      "shopify",
      snap({ grantsAccess: true, entitlements: ["shopify_catalog_sync"], shopify: { state: "ACTIVE" } as any }),
      { integrationConnected: false },
    );
    expect(paidButDisconnected.featuresEnabled).toBe(false);
    expect(paidButDisconnected.installationLabelKey).toBe("marketplace.shopifyAccess.disconnected");
  });
});

describe("4. uninstalled from Shopify", () => {
  const a = presentShopifyFeatureAccess(
    "shopify",
    snap({ installation: { ...snap().installation, uninstalledAt: "2026-09-30T00:00:00.000Z" } as any }),
    { integrationConnected: true },
  );
  it("is not authorized and claims nothing", () => {
    expect(a.authorized).toBe(false);
    expect(a.featuresEnabled).toBe(false);
    expect(a.showConnectorRequired).toBe(false);
  });
});

describe("5. active paid Connector - the control", () => {
  const a = presentShopifyFeatureAccess(
    "shopify",
    snap({ grantsAccess: true, entitlements: ["shopify_catalog_sync"], shopify: { state: "ACTIVE" } as any }),
    { integrationConnected: true },
  );
  it("presents as Active with features on", () => {
    expect(claims(a)).toEqual({ featuresEnabled: true, labelSaysActive: true });
    expect(a.showConnectorRequired).toBe(false);
  });
  it("proves the gate is not simply always closed", () => {
    // Without this, every assertion above would pass on a gate that denied
    // everything, and the product would be broken for paying merchants.
    expect(a.featuresEnabled).toBe(true);
  });
});

describe("non-Shopify integrations are untouched in every state", () => {
  it("stays enabled whatever Shopify's lifecycle is doing", () => {
    for (const connected of [true, false]) {
      const a = presentShopifyFeatureAccess("airtable", snap(), { integrationConnected: connected });
      expect(a.applies).toBe(false);
      expect(a.featuresEnabled).toBe(true);
    }
  });
});
