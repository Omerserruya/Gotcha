/**
 * The registry's job is to be boring and fail closed.
 *
 * These are the tests for the two ways this could quietly go wrong: resolving
 * to something that GRANTS Shopify access while unconfigured, or resolving to
 * something that CHARGES while half-configured. Both would look like success.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getBillingSource, shopifyBillingUsable, BillingSourceUnavailableError } from "../billing-sources";
import {
  assertBillingCapability,
  BillingCapabilityUnavailableError,
  GOTCHA_EXTERNAL_CAPABILITIES,
  SHOPIFY_APP_PRICING_CAPABILITIES,
} from "../billing-sources/capabilities";
import {
  shopifyBillingMode,
  shopifyBillingEnv,
  shopifyAllowSplitBilling,
  shopifyAllowGrandfathered,
  shopifyPlanSelectionUrl,
  shopifyPlanHandles,
  assertShopifyBillingConfig,
  ShopifyBillingConfigError,
} from "../billing-sources/shopify/config";

const ORIGINAL = { ...process.env };

function resetEnv() {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("SHOPIFY_")) delete process.env[k];
  }
}

beforeEach(() => {
  resetEnv();
});

afterAll(() => {
  process.env = { ...ORIGINAL };
});

const REF = {
  tenantId: "t1",
  billableEntityId: "e1",
  productKey: "gotcha_core",
};

describe("defaults preserve today's production behaviour", () => {
  it("Shopify billing is off when nothing is configured", () => {
    expect(shopifyBillingMode()).toBe("disabled");
    expect(shopifyBillingUsable()).toBe(false);
  });

  it("an unconfigured SHOPIFY source refuses to start a subscription", async () => {
    const src = getBillingSource("SHOPIFY");
    await expect(src.beginSubscription({
      tenantId: "t1", billableEntityId: "e1", productKey: "shopify_connector",
      returnUrl: "https://app.gotcha.co.il/x", idempotencyKey: "k1",
    })).rejects.toBeInstanceOf(BillingSourceUnavailableError);
  });

  it("an unconfigured SHOPIFY source grants nothing - and does not throw doing it", async () => {
    // null is the correct answer, and it must not be an exception: every stack
    // that has not enabled Shopify still runs reconciliation over this path.
    await expect(getBillingSource("SHOPIFY").fetchSubscription(REF)).resolves.toBeNull();
  });

  it("usage dispatched to an unconfigured Shopify is refused PERMANENTLY, not retried", async () => {
    const res = await getBillingSource("SHOPIFY").dispatchUsage!({
      ledgerEntryId: "l1", tenantId: "t1", meterHandle: "m", quantity: "1",
      occurredAt: new Date(), idempotencyKey: "u1",
    });
    expect(res.accepted).toBe(false);
    // Not permanent would mean retrying forever against a switched-off feature.
    expect(res.permanent).toBe(true);
    expect(res.failureCode).toBe("shopify_billing_unconfigured");
  });
});

describe("a named mode is still not a working mode", () => {
  it("app_pricing with no app handle refuses rather than building a broken URL", async () => {
    process.env.SHOPIFY_BILLING_ENABLED = "true";
    process.env.SHOPIFY_BILLING_MODE = "app_pricing";
    expect(shopifyBillingMode()).toBe("app_pricing");
    // The flag is on and the real adapter is wired, and it is STILL not usable:
    // capabilities remain unverified until exercised against a real dev store.
    // That separation - configured is not the same as proven - is the point.
    expect(shopifyBillingUsable()).toBe(false);
    await expect(getBillingSource("SHOPIFY").beginSubscription({
      tenantId: "t1", billableEntityId: "e1", productKey: "shopify_connector",
      shopDomain: "acme.myshopify.com",
      returnUrl: "https://app.gotcha.co.il/x", idempotencyKey: "k",
    })).rejects.toBeInstanceOf(BillingSourceUnavailableError);
  });

  it("app_pricing sends the merchant to Shopify's hosted page, and reports PENDING", async () => {
    process.env.SHOPIFY_BILLING_ENABLED = "true";
    process.env.SHOPIFY_BILLING_MODE = "app_pricing";
    process.env.SHOPIFY_APP_HANDLE = "gotcha-chat";
    const res = await getBillingSource("SHOPIFY").beginSubscription({
      tenantId: "t1", billableEntityId: "e1", productKey: "shopify_connector",
      shopDomain: "acme.myshopify.com",
      returnUrl: "https://app.gotcha.co.il/x", idempotencyKey: "k",
    });
    expect(res.redirectUrl).toBe("https://admin.shopify.com/store/acme/charges/gotcha-chat/pricing_plans");
    // PENDING no matter what: sending someone to a payment page is not evidence
    // that they paid, and only fetchSubscription may move this to ACTIVE.
    expect(res.status).toBe("PENDING");
  });

  it("a mock app_pricing stack invents NO subscription - so activation cannot pass by accident", async () => {
    process.env.SHOPIFY_BILLING_ENABLED = "true";
    process.env.SHOPIFY_BILLING_MODE = "app_pricing";
    const observed = await getBillingSource("SHOPIFY").fetchSubscription({
      tenantId: "t1", billableEntityId: "e1", productKey: "shopify_connector",
      externalShopId: "12345",
    });
    expect(observed).toBeNull();
  });

  it("a typo in the mode disables Shopify rather than selecting one", () => {
    process.env.SHOPIFY_BILLING_ENABLED = "true";
    process.env.SHOPIFY_BILLING_MODE = "app-pricing"; // hyphen, not underscore
    expect(shopifyBillingMode()).toBe("disabled");
  });

  it("the mode is re-read per call, so one test cannot fix it for the next", () => {
    process.env.SHOPIFY_BILLING_ENABLED = "true";
    process.env.SHOPIFY_BILLING_MODE = "manual";
    expect(shopifyBillingMode()).toBe("manual");
    delete process.env.SHOPIFY_BILLING_ENABLED;
    expect(shopifyBillingMode()).toBe("disabled");
  });
});

describe("live money needs a second, explicit acknowledgement", () => {
  it("env=live without the acknowledgement degrades to mock", () => {
    process.env.SHOPIFY_BILLING_ENV = "live";
    expect(shopifyBillingEnv()).toBe("mock");
  });

  it("env=live with the acknowledgement is live", () => {
    process.env.SHOPIFY_BILLING_ENV = "live";
    process.env.SHOPIFY_ALLOW_LIVE_BILLING = "true";
    expect(shopifyBillingEnv()).toBe("live");
  });

  it("an unknown env is mock, never a guess", () => {
    process.env.SHOPIFY_BILLING_ENV = "production";
    expect(shopifyBillingEnv()).toBe("mock");
  });
});

describe("the two policy switches default to the safe answer", () => {
  it("split billing is off until Shopify says otherwise", () => {
    expect(shopifyAllowSplitBilling()).toBe(false);
  });

  it("grandfathering is off by default", () => {
    expect(shopifyAllowGrandfathered()).toBe(false);
  });
});

describe("capabilities fail closed on unverified", () => {
  it("GOTCHA_EXTERNAL can verify a subscription", () => {
    expect(() => assertBillingCapability("GOTCHA_EXTERNAL", GOTCHA_EXTERNAL_CAPABILITIES, "verifySubscription")).not.toThrow();
  });

  it("an unverified Shopify capability is refused exactly like an unsupported one", () => {
    expect(SHOPIFY_APP_PRICING_CAPABILITIES.createSubscription).toBe("unverified");
    expect(() => assertBillingCapability("SHOPIFY", SHOPIFY_APP_PRICING_CAPABILITIES, "createSubscription"))
      .toThrow(BillingCapabilityUnavailableError);
  });

  it("split billing is UNVERIFIED for Shopify - the open question, in code", () => {
    expect(SHOPIFY_APP_PRICING_CAPABILITIES.splitBilling).toBe("unverified");
    expect(() => assertBillingCapability("SHOPIFY", SHOPIFY_APP_PRICING_CAPABILITIES, "splitBilling")).toThrow();
  });

  it("App Pricing declares NO subscription webhooks - Shopify stopped sending them", () => {
    expect(SHOPIFY_APP_PRICING_CAPABILITIES.subscriptionWebhooks).toBe("unsupported");
  });
});

describe("non-charging sources", () => {
  it("EXEMPT and FREE report ACTIVE, so entitlements are not revoked from them", async () => {
    for (const s of ["EXEMPT", "FREE"] as const) {
      const observed = await getBillingSource(s).fetchSubscription(REF);
      expect(observed?.status).toBe("ACTIVE");
      expect(observed?.rawStatus).toBe(s);
      expect(observed?.externalId).toBeNull();
    }
  });

  it("they keep their own identity rather than collapsing into one", async () => {
    const exempt = await getBillingSource("EXEMPT").fetchSubscription(REF);
    const free = await getBillingSource("FREE").fetchSubscription(REF);
    expect(exempt!.rawStatus).not.toBe(free!.rawStatus);
  });

  it("an unrecognised source falls back to something that charges nothing", () => {
    const src = getBillingSource("NOT_A_SOURCE" as any);
    expect(src.capabilities.createSubscription).toBe("unsupported");
  });
});

describe("plan-selection URL", () => {
  it("is null without an app handle, rather than a malformed admin URL", () => {
    expect(shopifyPlanSelectionUrl("acme")).toBeNull();
  });

  it("uses the store HANDLE, tolerating a full myshopify domain", () => {
    process.env.SHOPIFY_APP_HANDLE = "gotcha-chat";
    expect(shopifyPlanSelectionUrl("acme")).toBe(
      "https://admin.shopify.com/store/acme/charges/gotcha-chat/pricing_plans",
    );
    expect(shopifyPlanSelectionUrl("acme.myshopify.com")).toBe(
      "https://admin.shopify.com/store/acme/charges/gotcha-chat/pricing_plans",
    );
  });

  it("is null for an empty store, not a URL with a hole in it", () => {
    process.env.SHOPIFY_APP_HANDLE = "gotcha-chat";
    expect(shopifyPlanSelectionUrl("")).toBeNull();
  });
});

describe("boot-time configuration checks", () => {
  it("says nothing when the integration is off", () => {
    expect(() => assertShopifyBillingConfig()).not.toThrow();
  });

  it("refuses to start when enabled without a mode", () => {
    process.env.SHOPIFY_BILLING_ENABLED = "true";
    expect(() => assertShopifyBillingConfig()).toThrow(ShopifyBillingConfigError);
  });

  it("refuses app_pricing with no app handle - there would be nowhere to send anyone", () => {
    process.env.SHOPIFY_BILLING_ENABLED = "true";
    process.env.SHOPIFY_BILLING_MODE = "app_pricing";
    expect(() => assertShopifyBillingConfig()).toThrow(/SHOPIFY_APP_HANDLE/);
  });

  it("refuses malformed plan handle JSON at BOOT, not at a merchant's checkout", () => {
    process.env.SHOPIFY_BILLING_ENABLED = "true";
    process.env.SHOPIFY_BILLING_MODE = "manual";
    process.env.SHOPIFY_BILLING_PLAN_HANDLES = "{not json";
    expect(() => assertShopifyBillingConfig()).toThrow(/not valid JSON/);
  });

  it("app_pricing in a NETWORK env demands the Partner API token", () => {
    process.env.SHOPIFY_BILLING_ENABLED = "true";
    process.env.SHOPIFY_BILLING_MODE = "app_pricing";
    process.env.SHOPIFY_APP_HANDLE = "gotcha-chat";
    process.env.SHOPIFY_BILLING_ENV = "test";
    // Without it there is literally no way to learn that a merchant paid,
    // because App Pricing sends no webhooks.
    expect(() => assertShopifyBillingConfig()).toThrow(/SHOPIFY_PARTNER_API_TOKEN/);
  });

  it("a mock stack needs no credentials at all", () => {
    process.env.SHOPIFY_BILLING_ENABLED = "true";
    process.env.SHOPIFY_BILLING_MODE = "app_pricing";
    process.env.SHOPIFY_APP_HANDLE = "gotcha-chat";
    expect(() => assertShopifyBillingConfig()).not.toThrow();
  });

  it("a malformed handle map reads as empty rather than throwing at read time", () => {
    process.env.SHOPIFY_BILLING_PLAN_HANDLES = "{not json";
    expect(shopifyPlanHandles()).toEqual({});
  });
});
