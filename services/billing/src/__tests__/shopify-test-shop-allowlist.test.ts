/**
 * The test-shop list, AFTER it stopped being a gate.
 *
 * WHAT CHANGED, AND WHY THIS FILE INVERTED
 * ----------------------------------------
 * `SHOPIFY_BILLING_TEST_SHOPS` used to decide who could enter the Shopify App
 * Pricing flow while `SHOPIFY_BILLING_ENV=test`. A store nobody had listed was
 * connected and then silently excluded from billing. This file used to assert
 * that exclusion held.
 *
 * Shopify App Store review 132211 rejected that shape. A reviewer works from an
 * ordinary development store that nobody added to a server-side list, so an
 * allowlist means the reviewer - and every real merchant during the same
 * window - takes a different code path from the one being reviewed. An app
 * whose behaviour depends on whether the tenant was named in configuration
 * cannot be assessed. The finding covers any reviewer-specific tenant, shop or
 * workspace allowlist, so replacing this one with a differently-named list
 * would not have answered it.
 *
 * So the tests now pin the OPPOSITE property: parsing still works, and nothing
 * anywhere branches on the result. The protections that actually keep test
 * money from becoming real money are unchanged and asserted at the bottom -
 * `SHOPIFY_BILLING_ENABLED`, `SHOPIFY_BILLING_ENV`, `SHOPIFY_ALLOW_LIVE_BILLING`,
 * and Shopify's own $0 pricing on development stores.
 *
 * No database and no network: a pure predicate over configuration, plus one
 * source scan.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  shopifyBillingTestShops,
  invalidTestShopEntries,
  isListedShopifyTestShop,
  shopifyBillingEnv,
} from "../billing-sources/shopify/config";

const ORIGINAL = { ...process.env };

beforeEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("SHOPIFY_")) delete process.env[k];
  }
});

afterAll(() => {
  process.env = { ...ORIGINAL };
});

// ─── The parser still works ──────────────────────────────────────────────
//
// Retained because the list is still reported at boot, and a diagnostic that
// silently mangles what it reports is worse than no diagnostic.

describe("parsing", () => {
  it("reads a single shop", () => {
    process.env.SHOPIFY_BILLING_TEST_SHOPS = "acme-dev.myshopify.com";
    expect(shopifyBillingTestShops()).toEqual(["acme-dev.myshopify.com"]);
  });

  it("completes a bare handle", () => {
    process.env.SHOPIFY_BILLING_TEST_SHOPS = "acme-dev";
    expect(shopifyBillingTestShops()).toEqual(["acme-dev.myshopify.com"]);
  });

  it("strips a scheme and path from a pasted URL", () => {
    process.env.SHOPIFY_BILLING_TEST_SHOPS = "https://acme-dev.myshopify.com/admin";
    expect(shopifyBillingTestShops()).toEqual(["acme-dev.myshopify.com"]);
  });

  it("lowercases", () => {
    process.env.SHOPIFY_BILLING_TEST_SHOPS = "ACME-DEV.MYSHOPIFY.COM";
    expect(shopifyBillingTestShops()).toEqual(["acme-dev.myshopify.com"]);
  });

  it("splits on commas, whitespace and newlines, and de-duplicates", () => {
    process.env.SHOPIFY_BILLING_TEST_SHOPS = "a-dev, b-dev\nc-dev  a-dev";
    expect(shopifyBillingTestShops().sort()).toEqual([
      "a-dev.myshopify.com",
      "b-dev.myshopify.com",
      "c-dev.myshopify.com",
    ]);
  });

  it("never completes a dotted host into a myshopify subdomain", () => {
    // `evil.com` must not become `evil.com.myshopify.com`. The list is a
    // diagnostic now, but a parser that invents hosts is still a parser that
    // will mislead whoever reads the boot log.
    process.env.SHOPIFY_BILLING_TEST_SHOPS = "evil.com";
    expect(shopifyBillingTestShops()).toEqual([]);
    expect(invalidTestShopEntries()).toEqual(["evil.com"]);
  });

  it("drops a bad entry without taking the rest of the list with it", () => {
    process.env.SHOPIFY_BILLING_TEST_SHOPS = "good-dev, evil.com, other-dev";
    expect(shopifyBillingTestShops().sort()).toEqual([
      "good-dev.myshopify.com",
      "other-dev.myshopify.com",
    ]);
    expect(invalidTestShopEntries()).toEqual(["evil.com"]);
  });

  it("is empty when unset", () => {
    expect(shopifyBillingTestShops()).toEqual([]);
    expect(invalidTestShopEntries()).toEqual([]);
  });
});

// ─── It reports; it does not decide ──────────────────────────────────────

describe("isListedShopifyTestShop is a report, not a permission", () => {
  it("answers the same question in every environment", () => {
    // The old predicate returned true for everyone in `live` and `mock`, and
    // consulted the list only in `test` - which is what made it a gate. This
    // one has no environment in it at all.
    process.env.SHOPIFY_BILLING_TEST_SHOPS = "acme-dev.myshopify.com";
    for (const e of ["mock", "test", "live"] as const) {
      process.env.SHOPIFY_BILLING_ENV = e;
      process.env.SHOPIFY_ALLOW_LIVE_BILLING = "true";
      expect(isListedShopifyTestShop("acme-dev.myshopify.com")).toBe(true);
      expect(isListedShopifyTestShop("other.myshopify.com")).toBe(false);
    }
  });

  it("refuses a suffix attack and an unparseable domain", () => {
    process.env.SHOPIFY_BILLING_TEST_SHOPS = "acme.myshopify.com";
    expect(isListedShopifyTestShop("acme.myshopify.com.evil.com")).toBe(false);
    expect(isListedShopifyTestShop(null)).toBe(false);
    expect(isListedShopifyTestShop(undefined)).toBe(false);
    expect(isListedShopifyTestShop("")).toBe(false);
  });
});

// ─── The gate must not come back ─────────────────────────────────────────

describe("no shop, tenant or workspace allowlist gates the flow", () => {
  const SRC = path.resolve(__dirname, "..");

  /**
   * Source with comments removed.
   *
   * The comments in these files NAME the removed predicate and the variable,
   * deliberately - "this used to gate here, and must not again" is the most
   * useful thing a future reader can find at the call site. A scan that cannot
   * tell prose from code would force that history to be deleted to keep the
   * test green, which is the wrong trade.
   */
  function read(rel: string): string {
    return fs
      .readFileSync(path.join(SRC, rel), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
  }

  it("the old predicate no longer exists anywhere", () => {
    // Named explicitly: reintroducing `shopifyBillingAppliesToShop` is the
    // single most likely way for this regression to return, because every call
    // site that used it reads naturally with it back.
    const files = [
      "billing-sources/shopify/config.ts",
      "routes/shopify-billing.ts",
      "services/shopify-post-install.service.ts",
    ];
    for (const f of files) {
      expect(read(f), f).not.toMatch(/shopifyBillingAppliesToShop/);
    }
  });

  it("nothing branches on the test-shop list", () => {
    // The list may be READ (to report it) but never tested. An `if` around
    // either accessor is the gate, whatever it is called.
    for (const f of [
      "billing-sources/shopify/config.ts",
      "routes/shopify-billing.ts",
      "services/shopify-post-install.service.ts",
    ]) {
      const src = read(f);
      expect(src, f).not.toMatch(/if\s*\(\s*!?\s*(shopifyBillingTestShops|isListedShopifyTestShop)\s*\(/);
    }
  });

  it("no route refuses a store for not being enabled on this deployment", () => {
    // The merchant-visible half of the same bug: a 409 that says the store is
    // not enabled here is an allowlist by another name.
    expect(read("routes/shopify-billing.ts")).not.toMatch(
      /shopify_billing_not_enabled_for_shop/,
    );
  });

  it("post-install runs the same steps for a store nobody listed", () => {
    // The early return that used to sit between linking and grandfathering is
    // gone: there is exactly one `UNRESOLVED` exit left, the billing-disabled
    // one, and it does not read a shop.
    const src = read("services/shopify-post-install.service.ts");
    const unresolvedExits = src.match(/state:\s*"UNRESOLVED"/g) ?? [];
    expect(unresolvedExits).toHaveLength(1);
    expect(src).not.toMatch(/SHOPIFY_BILLING_TEST_SHOPS/);
  });
});

// ─── What actually keeps test money from becoming real money ─────────────

describe("the protections that remain", () => {
  it("live billing still needs its own explicit acknowledgement", () => {
    process.env.SHOPIFY_BILLING_ENABLED = "true";
    process.env.SHOPIFY_BILLING_MODE = "app_pricing";
    process.env.SHOPIFY_BILLING_ENV = "live";
    // Removing the allowlist must not have loosened this. Without the second
    // variable, `live` degrades to `mock`, which reaches Shopify not at all.
    expect(shopifyBillingEnv()).toBe("mock");
    process.env.SHOPIFY_ALLOW_LIVE_BILLING = "true";
    expect(shopifyBillingEnv()).toBe("live");
  });

  it("defaults to mock when nothing is configured", () => {
    expect(shopifyBillingEnv()).toBe("mock");
  });
});
