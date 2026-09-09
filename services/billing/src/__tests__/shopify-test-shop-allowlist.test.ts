/**
 * The test-shop allowlist.
 *
 * WHAT IT IS PROTECTING AGAINST
 * -----------------------------
 * Testing runs against the PRODUCTION Partner app, on the production host,
 * beside real merchants. `test` is not an isolated environment - it is the same
 * deployment with a flag flipped, and Shopify's $0-on-development-stores rule
 * is the only thing between a test charge and a real one.
 *
 * Without this list, flipping that flag would put every connected store into
 * plan selection at once: real merchants redirected to a Shopify pricing page
 * they never asked for, during a window meant to exercise one dev store.
 *
 * So the failure mode of a forgotten variable must be "the test does not
 * start", and never "every merchant is enrolled".
 *
 * No database and no network: this is a pure predicate over configuration and
 * one already-verified shop domain.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  shopifyBillingTestShops,
  invalidTestShopEntries,
  shopifyBillingAppliesToShop,
} from "../billing-sources/shopify/config";

const ORIGINAL = { ...process.env };

function env(e: "mock" | "test" | "live", shops?: string) {
  process.env.SHOPIFY_BILLING_ENABLED = "true";
  process.env.SHOPIFY_BILLING_MODE = "app_pricing";
  process.env.SHOPIFY_BILLING_ENV = e;
  if (e === "live") process.env.SHOPIFY_ALLOW_LIVE_BILLING = "true";
  if (shops !== undefined) process.env.SHOPIFY_BILLING_TEST_SHOPS = shops;
}

beforeEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("SHOPIFY_")) delete process.env[k];
  }
});

afterAll(() => {
  process.env = { ...ORIGINAL };
});

describe("exact match", () => {
  it("admits a listed shop", () => {
    env("test", "acme-dev.myshopify.com");
    expect(shopifyBillingAppliesToShop("acme-dev.myshopify.com")).toBe(true);
  });

  it("refuses a shop that is not listed", () => {
    env("test", "acme-dev.myshopify.com");
    // A real merchant, mid-test-window. Must behave exactly as it does today.
    expect(shopifyBillingAppliesToShop("real-merchant.myshopify.com")).toBe(false);
  });

  it("does not match on a prefix", () => {
    env("test", "acme-dev.myshopify.com");
    expect(shopifyBillingAppliesToShop("acme.myshopify.com")).toBe(false);
  });

  it("does not match on a longer handle sharing the prefix", () => {
    env("test", "acme.myshopify.com");
    expect(shopifyBillingAppliesToShop("acme-dev.myshopify.com")).toBe(false);
  });
});

describe("normalization", () => {
  it("accepts a bare handle in the configuration", () => {
    env("test", "acme-dev");
    expect(shopifyBillingTestShops()).toEqual(["acme-dev.myshopify.com"]);
    expect(shopifyBillingAppliesToShop("acme-dev.myshopify.com")).toBe(true);
  });

  it("is case-insensitive on both sides", () => {
    env("test", "ACME-Dev.MyShopify.COM");
    expect(shopifyBillingAppliesToShop("acme-dev.myshopify.com")).toBe(true);
    expect(shopifyBillingAppliesToShop("ACME-DEV.MYSHOPIFY.COM")).toBe(true);
  });

  it("tolerates a pasted URL", () => {
    env("test", "https://acme-dev.myshopify.com/admin");
    expect(shopifyBillingTestShops()).toEqual(["acme-dev.myshopify.com"]);
  });

  it("strips a path, including a traversal-looking one", () => {
    // Deliberate, and not a bypass: stripping a path can only ever resolve to
    // the host the operator literally wrote. The CHECK side never sees a path
    // at all - a runtime shop domain comes from a Shopify-signed request.
    env("test", "acme-dev.myshopify.com/../other");
    expect(shopifyBillingTestShops()).toEqual(["acme-dev.myshopify.com"]);
    expect(shopifyBillingAppliesToShop("other.myshopify.com")).toBe(false);
  });

  it("tolerates surrounding whitespace and a trailing dot", () => {
    env("test", "   acme-dev.myshopify.com.   ");
    expect(shopifyBillingTestShops()).toEqual(["acme-dev.myshopify.com"]);
  });

  it("does not admit a bare handle at CHECK time", () => {
    // The runtime side stays strict. Only Shopify's canonical form is a shop;
    // accepting a slug here would let a caller pass something Shopify never
    // said.
    env("test", "acme-dev");
    expect(shopifyBillingAppliesToShop("acme-dev")).toBe(false);
  });
});

describe("multiple shops", () => {
  it("accepts a comma-separated list", () => {
    env("test", "a-dev,b-dev.myshopify.com,c-dev");
    expect(shopifyBillingTestShops().sort()).toEqual([
      "a-dev.myshopify.com",
      "b-dev.myshopify.com",
      "c-dev.myshopify.com",
    ]);
  });

  it("accepts whitespace and newline separation", () => {
    env("test", "a-dev.myshopify.com\n  b-dev.myshopify.com\tc-dev");
    expect(shopifyBillingTestShops()).toHaveLength(3);
  });

  it("admits every listed shop and nothing else", () => {
    env("test", "a-dev, b-dev");
    expect(shopifyBillingAppliesToShop("a-dev.myshopify.com")).toBe(true);
    expect(shopifyBillingAppliesToShop("b-dev.myshopify.com")).toBe(true);
    expect(shopifyBillingAppliesToShop("c-dev.myshopify.com")).toBe(false);
  });

  it("de-duplicates entries written more than once", () => {
    env("test", "a-dev, a-dev.myshopify.com, https://a-dev.myshopify.com");
    expect(shopifyBillingTestShops()).toEqual(["a-dev.myshopify.com"]);
  });
});

describe("empty or missing configuration allows NOBODY", () => {
  it("unset", () => {
    env("test");
    expect(shopifyBillingTestShops()).toEqual([]);
    expect(shopifyBillingAppliesToShop("acme-dev.myshopify.com")).toBe(false);
  });

  it("empty string", () => {
    env("test", "");
    expect(shopifyBillingAppliesToShop("acme-dev.myshopify.com")).toBe(false);
  });

  it("whitespace and stray separators only", () => {
    env("test", "  , ,  ");
    expect(shopifyBillingTestShops()).toEqual([]);
    expect(shopifyBillingAppliesToShop("acme-dev.myshopify.com")).toBe(false);
  });

  it("a list of only INVALID entries admits nobody", () => {
    // The dangerous shape: the variable is set, so it looks configured.
    env("test", "evil.com, myshopify.com, http://");
    expect(shopifyBillingTestShops()).toEqual([]);
    expect(shopifyBillingAppliesToShop("evil.com")).toBe(false);
  });

  it("whitespace separation means a multi-word typo becomes several handles", () => {
    // Documented rather than defended against. `not a shop` is three
    // whitespace-separated tokens and each is a syntactically valid handle, so
    // the parser completes all three. They admit nothing real, and the boot
    // warning surfaces the count - but a reader should not be surprised by it.
    env("test", "not a shop");
    expect(shopifyBillingTestShops().sort()).toEqual([
      "a.myshopify.com",
      "not.myshopify.com",
      "shop.myshopify.com",
    ]);
    expect(shopifyBillingAppliesToShop("real-merchant.myshopify.com")).toBe(false);
  });
});

describe("malicious and non-myshopify domains", () => {
  const NASTY = [
    "acme-dev.myshopify.com.evil.com",
    "evil.com",
    "acme-dev.myshopify.com.attacker.net",
    "myshopify.com",
    "a.b.myshopify.com",
    "acme-dev.myshopify.co",
    "",
  ];

  it("none of them can be configured into the list", () => {
    for (const bad of NASTY) {
      env("test", bad);
      expect(shopifyBillingTestShops()).toEqual([]);
    }
  });

  it("none of them passes the check, even with a real shop listed", () => {
    env("test", "acme-dev.myshopify.com");
    for (const bad of NASTY) {
      expect(shopifyBillingAppliesToShop(bad)).toBe(false);
    }
  });

  it("a dotted host is REJECTED, never completed with the suffix", () => {
    // Completing `evil.com` into `evil.com.myshopify.com` would turn a rejected
    // entry into an accepted-looking one - the exact hazard the strict
    // validator exists to remove.
    env("test", "evil.com");
    expect(shopifyBillingTestShops()).toEqual([]);
    expect(shopifyBillingAppliesToShop("evil.com.myshopify.com")).toBe(false);
  });

  it("reports unparseable entries so a typo is findable", () => {
    env("test", "acme-dev, evil.com, myshopify.com");
    expect(shopifyBillingTestShops()).toEqual(["acme-dev.myshopify.com"]);
    expect(invalidTestShopEntries().sort()).toEqual(["evil.com", "myshopify.com"]);
  });

  it("refuses non-string and empty input", () => {
    env("test", "acme-dev.myshopify.com");
    expect(shopifyBillingAppliesToShop(null)).toBe(false);
    expect(shopifyBillingAppliesToShop(undefined)).toBe(false);
    expect(shopifyBillingAppliesToShop("")).toBe(false);
  });
});

describe("only test mode is gated", () => {
  it("live admits every shop and never reads the list", () => {
    // A stale test list surviving into live would silently exclude paying
    // merchants from billing - the same class of bug, pointing the other way.
    env("live", "only-this-one.myshopify.com");
    expect(shopifyBillingAppliesToShop("any-merchant.myshopify.com")).toBe(true);
    expect(shopifyBillingAppliesToShop("only-this-one.myshopify.com")).toBe(true);
  });

  it("live admits shops even with an EMPTY list", () => {
    env("live", "");
    expect(shopifyBillingAppliesToShop("any-merchant.myshopify.com")).toBe(true);
  });

  it("mock admits every shop, and reaches nothing", () => {
    env("mock", "");
    expect(shopifyBillingAppliesToShop("any-merchant.myshopify.com")).toBe(true);
  });

  it("an env of `live` WITHOUT the acknowledgement degrades to mock, and is still ungated", () => {
    process.env.SHOPIFY_BILLING_ENABLED = "true";
    process.env.SHOPIFY_BILLING_MODE = "app_pricing";
    process.env.SHOPIFY_BILLING_ENV = "live";
    // SHOPIFY_ALLOW_LIVE_BILLING deliberately unset => mock.
    process.env.SHOPIFY_BILLING_TEST_SHOPS = "";
    expect(shopifyBillingAppliesToShop("any-merchant.myshopify.com")).toBe(true);
  });
});
