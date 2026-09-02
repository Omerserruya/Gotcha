/**
 * The plan catalog.
 *
 * No database and no network: this is configuration parsing, and the failures
 * worth catching are all shapes of "an operator wrote something slightly wrong
 * and the system sold the wrong thing, or nothing, without saying so".
 *
 * The empty case gets as much attention as the populated one. An unconfigured
 * catalog MUST yield no sellable plan, because the alternative - falling back
 * to some default - would charge a merchant against a plan nobody defined.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  shopifyPlanCatalog,
  sellablePlans,
  plansAvailableToShop,
  soleAvailablePlan,
  findPlanByKey,
  findPlanForSubscription,
  classifyPlanChange,
  planEntitlements,
  validatePlanCatalog,
  PLACEHOLDER_PLAN_KEYS,
  SHOPIFY_CONNECTOR_PRODUCT,
} from "../billing-sources/shopify/plan-catalog";

const ORIGINAL = { ...process.env };

function setCatalog(plans: unknown) {
  process.env.SHOPIFY_BILLING_PLAN_CATALOG = JSON.stringify(plans);
}

beforeEach(() => {
  delete process.env.SHOPIFY_BILLING_PLAN_CATALOG;
  delete process.env.SHOPIFY_BILLING_PLAN_HANDLES;
});

afterAll(() => {
  process.env = { ...ORIGINAL };
});

describe("an unconfigured catalog sells nothing", () => {
  it("is empty rather than defaulted", () => {
    expect(shopifyPlanCatalog()).toEqual([]);
    expect(sellablePlans()).toEqual([]);
    expect(plansAvailableToShop("acme.myshopify.com")).toEqual([]);
  });

  it("has no sole plan to send anybody to", () => {
    expect(soleAvailablePlan("acme.myshopify.com")).toBeNull();
  });

  it("reserves the placeholder keys without making them sellable", () => {
    // Naming them is how docs and runbooks can refer to something stable
    // before the commercial decision lands. It must not imply availability.
    expect(PLACEHOLDER_PLAN_KEYS).toContain("SHOPIFY_CONNECTOR");
    expect(findPlanByKey("SHOPIFY_CONNECTOR")).toBeNull();
  });

  it("malformed JSON yields an empty catalog rather than a partial one", () => {
    process.env.SHOPIFY_BILLING_PLAN_CATALOG = "{not json";
    expect(shopifyPlanCatalog()).toEqual([]);
    expect(validatePlanCatalog()).toHaveLength(1);
  });
});

describe("the minimal form still works", () => {
  it("accepts a flat productKey -> handle map", () => {
    process.env.SHOPIFY_BILLING_PLAN_HANDLES = JSON.stringify({
      shopify_connector: "gotcha-connector",
    });
    const plans = sellablePlans();
    expect(plans).toHaveLength(1);
    expect(plans[0].handle).toBe("gotcha-connector");
    expect(plans[0].productKey).toBe("shopify_connector");
  });

  it("grants nothing until somebody says what a plan funds", () => {
    // A plan that silently granted everything would make the entitlement
    // mapping optional, and it is the entire point of the catalog.
    process.env.SHOPIFY_BILLING_PLAN_HANDLES = JSON.stringify({ shopify_connector: "h" });
    expect(sellablePlans()[0].entitlements).toEqual([]);
  });
});

describe("one plan is the expected case", () => {
  it("resolves a single available plan without a picker", () => {
    setCatalog([{ key: "SHOPIFY_CONNECTOR", handle: "gotcha-connector" }]);
    const sole = soleAvailablePlan("acme.myshopify.com");
    expect(sole?.key).toBe("SHOPIFY_CONNECTOR");
  });

  it("refuses to choose when several are available", () => {
    // Null means "we are not entitled to pick for them" and sends the merchant
    // to Shopify's own page, which IS allowed to present a choice.
    setCatalog([
      { key: "A", handle: "a" },
      { key: "B", handle: "b" },
    ]);
    expect(soleAvailablePlan("acme.myshopify.com")).toBeNull();
  });
});

describe("plans that must not be offered", () => {
  it("a disabled plan is not sellable", () => {
    setCatalog([{ key: "OLD", handle: "old", enabled: false }]);
    expect(sellablePlans()).toEqual([]);
  });

  it("a plan with no handle is not sellable", () => {
    // Declared for review, not wired up. There is nowhere to send a merchant.
    setCatalog([{ key: "DRAFT" }]);
    expect(shopifyPlanCatalog()).toHaveLength(1);
    expect(sellablePlans()).toEqual([]);
  });

  it("defaults to enabled when the field is absent", () => {
    setCatalog([{ key: "A", handle: "a" }]);
    expect(sellablePlans()).toHaveLength(1);
  });
});

describe("private plans and store-specific arrangements", () => {
  it("are offered only to the stores that name them", () => {
    setCatalog([
      { key: "PUBLIC", handle: "p" },
      { key: "PRIVATE", handle: "x", visibility: "private", restrictedToShops: ["acme"] },
    ]);
    expect(plansAvailableToShop("acme.myshopify.com").map((p) => p.key).sort()).toEqual([
      "PRIVATE",
      "PUBLIC",
    ]);
    expect(plansAvailableToShop("other.myshopify.com").map((p) => p.key)).toEqual(["PUBLIC"]);
  });

  it("matches a shop with or without the myshopify suffix", () => {
    setCatalog([
      { key: "P", handle: "x", visibility: "private", restrictedToShops: ["acme.myshopify.com"] },
    ]);
    expect(plansAvailableToShop("acme").map((p) => p.key)).toEqual(["P"]);
    expect(plansAvailableToShop("ACME.myshopify.com").map((p) => p.key)).toEqual(["P"]);
  });

  it("is offered to nobody when the shop is unknown", () => {
    setCatalog([
      { key: "P", handle: "x", visibility: "private", restrictedToShops: ["acme"] },
    ]);
    expect(plansAvailableToShop(null)).toEqual([]);
  });

  it("a private plan naming no shops is a config error", () => {
    setCatalog([{ key: "P", handle: "x", visibility: "private" }]);
    expect(validatePlanCatalog().join(" ")).toMatch(/can never be offered/);
  });
});

describe("identifying what a merchant actually bought", () => {
  it("matches on handle first", () => {
    setCatalog([
      { key: "MONTHLY", handle: "conn-monthly", interval: "monthly", rank: 1 },
      { key: "ANNUAL", handle: "conn-annual", interval: "annual", rank: 1 },
    ]);
    expect(findPlanForSubscription({ handle: "conn-annual" })?.key).toBe("ANNUAL");
  });

  it("falls back to the name only when no handle matched", () => {
    // Shopify's `name` is merchant-facing text editable in the Partner
    // Dashboard, so it is a hint of last resort rather than an identifier.
    setCatalog([{ key: "MONTHLY", handle: "conn-monthly" }]);
    expect(findPlanForSubscription({ handle: null, name: "MONTHLY" })?.key).toBe("MONTHLY");
    expect(findPlanForSubscription({ handle: "unknown", name: "MONTHLY" })?.key).toBe("MONTHLY");
  });

  it("an unrecognised plan funds NOTHING", () => {
    // The merchant genuinely paid Shopify for something, but we do not know
    // what. Inventing a grant would hand out capability on a guess.
    setCatalog([{ key: "A", handle: "a", entitlements: ["shopify_catalog_sync"] }]);
    expect(planEntitlements("SOMETHING_ELSE")).toEqual([]);
    expect(planEntitlements(null)).toEqual([]);
    expect(planEntitlements("A")).toEqual(["shopify_catalog_sync"]);
  });
});

describe("upgrades and downgrades", () => {
  beforeEach(() => {
    setCatalog([
      { key: "CONNECTOR", handle: "c", rank: 1 },
      { key: "AI_COMMERCE", handle: "ac", rank: 2 },
      { key: "SCALE", handle: "s", rank: 3 },
      { key: "CONNECTOR_ANNUAL", handle: "ca", rank: 1, interval: "annual" },
    ]);
  });

  it("classifies a move up the ranks as an upgrade", () => {
    expect(classifyPlanChange("CONNECTOR", "SCALE")).toBe("upgrade");
  });

  it("classifies a move down as a downgrade", () => {
    expect(classifyPlanChange("SCALE", "CONNECTOR")).toBe("downgrade");
  });

  it("treats equal ranks as lateral, which is the monthly/annual swap", () => {
    expect(classifyPlanChange("CONNECTOR", "CONNECTOR_ANNUAL")).toBe("lateral");
  });

  it("says unknown rather than guessing when a plan is not in the catalog", () => {
    expect(classifyPlanChange("CONNECTOR", "GONE")).toBe("unknown");
  });
});

describe("configuration mistakes that would sell the wrong thing", () => {
  it("rejects two plans sharing one Shopify handle", () => {
    // The observed subscription would be ambiguous: verification could not tell
    // which plan, and so which entitlements, the merchant bought.
    setCatalog([
      { key: "A", handle: "same" },
      { key: "B", handle: "same" },
    ]);
    expect(validatePlanCatalog().join(" ")).toMatch(/must identify exactly one plan/);
  });

  it("rejects a duplicate plan key", () => {
    setCatalog([
      { key: "A", handle: "a" },
      { key: "A", handle: "b" },
    ]);
    expect(validatePlanCatalog().join(" ")).toMatch(/duplicate plan key/);
  });

  it("keeps the FIRST definition of a duplicated key, not the last", () => {
    // Silently taking the last would make the effective plan depend on array
    // order, which is invisible in review.
    setCatalog([
      { key: "A", handle: "first" },
      { key: "A", handle: "second" },
    ]);
    expect(findPlanByKey("A")?.handle).toBe("first");
  });

  it("rejects a catalog that is not an array", () => {
    process.env.SHOPIFY_BILLING_PLAN_CATALOG = JSON.stringify({ nope: true });
    expect(validatePlanCatalog().join(" ")).toMatch(/must be a JSON array/);
  });

  it("accepts the object form with a plans array", () => {
    process.env.SHOPIFY_BILLING_PLAN_CATALOG = JSON.stringify({
      plans: [{ key: "A", handle: "a" }],
    });
    expect(validatePlanCatalog()).toEqual([]);
    expect(sellablePlans()).toHaveLength(1);
  });

  it("skips an entry with no key instead of taking the whole catalog down", () => {
    setCatalog([{ handle: "orphan" }, { key: "GOOD", handle: "g" }]);
    expect(sellablePlans().map((p) => p.key)).toEqual(["GOOD"]);
    expect(validatePlanCatalog().join(" ")).toMatch(/is not a usable plan/);
  });

  it("defaults an unstated productKey to the connector product", () => {
    setCatalog([{ key: "A", handle: "a" }]);
    expect(findPlanByKey("A")?.productKey).toBe(SHOPIFY_CONNECTOR_PRODUCT);
  });

  it("carries no price, currency or trial anywhere in the parsed shape", () => {
    // Shopify owns all three. A copy here would eventually disagree with what
    // the merchant was actually shown and charged.
    setCatalog([{ key: "A", handle: "a", price: 19, currency: "USD", trialDays: 14 }]);
    const plan = findPlanByKey("A")!;
    expect(Object.keys(plan)).not.toContain("price");
    expect(Object.keys(plan)).not.toContain("currency");
    expect(Object.keys(plan)).not.toContain("trialDays");
  });
});
