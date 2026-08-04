/**
 * Scope normalization and fail-closed capability gating.
 *
 * Both behaviours here come from reading a real grant, not from the docs.
 *
 * 1. Shopify's `access_scopes.json` returns the COLLAPSED grant: a granted
 *    `write_orders` is listed without the `read_orders` it confers. A live
 *    read of the demo store returned 19 handles for a 26-scope grant, the 7
 *    absent ones all being implied reads. Code that compares the raw response
 *    against a required list reports healthy stores as broken.
 *
 * 2. `grantedScopes` was null on EVERY installation in both databases, and
 *    the old gate read empty as "everything granted". Unknown must mean
 *    unknown, or an agent is shown buttons whose authority nobody checked.
 */
import { describe, it, expect } from "vitest";
import {
  expandImpliedScopes,
  normalizeGrantedScopes,
  readScopeState,
  hasScope,
  missingScopes,
} from "../services/connectors/shopify-scopes";

/** Exactly what Shopify returned for the demo store's 26-scope grant. */
const LIVE_COLLAPSED = [
  "read_all_orders", "read_assigned_fulfillment_orders", "write_customers",
  "write_price_rules", "write_discounts", "read_draft_orders", "read_fulfillments",
  "read_inventory", "read_inventory_shipments", "read_inventory_shipments_received_items",
  "read_inventory_transfers", "read_merchant_managed_fulfillment_orders",
  "write_order_edits", "write_orders", "read_product_feeds", "read_product_listings",
  "read_products", "write_returns", "read_third_party_fulfillment_orders",
];

describe("expandImpliedScopes", () => {
  it("derives the read scope a granted write confers", () => {
    const s = expandImpliedScopes(["write_orders"]);
    expect(s.has("write_orders")).toBe(true);
    expect(s.has("read_orders")).toBe(true);
  });

  it("recovers every implied read Shopify omitted from a real grant", () => {
    // This is the exact failure: the store CAN read orders and customers, but
    // the raw response never says so.
    const s = expandImpliedScopes(LIVE_COLLAPSED);
    for (const implied of [
      "read_orders", "read_customers", "read_returns",
      "read_price_rules", "read_discounts", "read_order_edits",
    ]) {
      expect(s.has(implied), `${implied} should be implied`).toBe(true);
    }
  });

  it("turns 19 collapsed handles into 25 effective scopes", () => {
    expect(normalizeGrantedScopes(LIVE_COLLAPSED)).toHaveLength(25);
  });

  it("shows the live grant is one scope short of the approved 26", () => {
    // Pinned deliberately. The approved set adds
    // `write_merchant_managed_fulfillment_orders`, which
    // `update_order_fulfillment` requires and which the live app does NOT
    // currently hold. Adding it to the app config is a scope EXPANSION, so
    // every already-connected merchant must re-consent before that tool can
    // work. If this test ever starts failing because the scope appears, the
    // grant was widened and the reauthorization note can be retired.
    const effective = new Set(normalizeGrantedScopes(LIVE_COLLAPSED));
    expect(effective.has("read_merchant_managed_fulfillment_orders")).toBe(true);
    expect(effective.has("write_merchant_managed_fulfillment_orders")).toBe(false);
  });

  it("is idempotent, so re-normalizing stored scopes is safe", () => {
    const once = normalizeGrantedScopes(LIVE_COLLAPSED);
    expect(normalizeGrantedScopes(once)).toEqual(once);
  });

  it("never invents a write from a read", () => {
    expect(expandImpliedScopes(["read_orders"]).has("write_orders")).toBe(false);
  });

  it("ignores blank entries rather than storing empty scopes", () => {
    expect(normalizeGrantedScopes(["", "  ", "read_products"])).toEqual(["read_products"]);
  });
});

describe("readScopeState — unknown is not permission", () => {
  it.each([
    ["missing config", null],
    ["no grantedScopes key", {}],
    ["explicit null", { grantedScopes: null }],
    ["empty array", { grantedScopes: [] }],
    ["wrong type", { grantedScopes: "read_orders" }],
  ])("treats %s as unknown", (_label, config) => {
    expect(readScopeState(config).verification).toBe("unknown");
  });

  it("treats a real grant as verified", () => {
    expect(readScopeState({ grantedScopes: LIVE_COLLAPSED }).verification).toBe("verified");
  });
});

describe("hasScope — fails closed", () => {
  it("refuses every scope when the grant was never read", () => {
    // The old gate returned TRUE here for everything, which is how an
    // unverified store came to advertise refund and cancel buttons.
    const unknown = readScopeState({});
    for (const s of ["read_orders", "write_orders", "write_returns"]) {
      expect(hasScope(unknown, s)).toBe(false);
    }
  });

  it("allows a scope only when it is actually present", () => {
    const st = readScopeState({ grantedScopes: ["write_orders"] });
    expect(hasScope(st, "write_orders")).toBe(true);
    expect(hasScope(st, "read_orders")).toBe(true);   // implied
    expect(hasScope(st, "write_returns")).toBe(false); // not granted
  });

  it("grants read via the collapsed live payload", () => {
    const st = readScopeState({ grantedScopes: LIVE_COLLAPSED });
    expect(hasScope(st, "read_orders")).toBe(true);
    expect(hasScope(st, "read_customers")).toBe(true);
  });
});

describe("missingScopes", () => {
  it("reports everything missing when the grant is unknown", () => {
    const req = ["write_orders", "write_returns"];
    expect(missingScopes(readScopeState({}), req)).toEqual(req);
  });

  it("reports nothing missing for the full live grant", () => {
    const st = readScopeState({ grantedScopes: LIVE_COLLAPSED });
    expect(missingScopes(st, ["read_orders", "write_orders", "write_returns", "read_customers"])).toEqual([]);
  });

  it("names the gap for a partially-granted store", () => {
    // The two older demo installs are exactly this shape: they can read and
    // cancel, but cannot open a return.
    const st = readScopeState({ grantedScopes: ["write_orders", "write_customers", "read_returns"] });
    expect(missingScopes(st, ["write_orders", "write_returns", "write_order_edits"]))
      .toEqual(["write_returns", "write_order_edits"]);
  });
});
