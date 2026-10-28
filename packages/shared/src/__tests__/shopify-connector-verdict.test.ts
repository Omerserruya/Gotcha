/**
 * The Shopify Connector's one verdict (split billing 2026-10-28).
 *
 * Access is an AND of four facts: installed, the connection live, a granting
 * billing state, and every entitlement the current catalog plan funds. A
 * capability needs the first three and its own row. Each condition is
 * mutated away below and each mutation must deny; one entitlement must never
 * open another. "Authorized" (OAuth) is never "active".
 */
import { describe, it, expect } from "vitest";
import { shopifyConnectorVerdict, type ShopifyConnectorVerdictInput } from "../lib/billing/shopify-connector-verdict";

const FOUR = ["shopify_catalog_sync", "shopify_order_read", "shopify_order_actions", "shopify_storefront_widget"];

/** Installed, live, ACTIVE, every planned entitlement held. Each test breaks one thing. */
const HEALTHY: ShopifyConnectorVerdictInput = {
  state: "ACTIVE",
  installationStatus: "CONNECTED",
  uninstalledAt: null,
  uninstallRequestedAt: null,
  entitlements: FOUR,
  requiredEntitlements: FOUR,
};
const v = (o: Partial<ShopifyConnectorVerdictInput> = {}) => shopifyConnectorVerdict({ ...HEALTHY, ...o });
const allCaps = (o: Partial<ShopifyConnectorVerdictInput>) => Object.values(v(o).capabilities);

describe("the control", () => {
  it("installed + live + ACTIVE + all four: access, every capability, active", () => {
    expect(v()).toEqual({
      scope: "shopify_connector",
      billedBy: "shopify",
      grantsAccess: true,
      capabilities: { shopify_catalog_sync: true, shopify_order_read: true, shopify_order_actions: true, shopify_storefront_widget: true },
      status: "active",
    });
  });
  it("TRIALING is access, shown as trialing", () => {
    expect(v({ state: "TRIALING" })).toMatchObject({ grantsAccess: true, status: "trialing" });
  });
});

describe("mutations: removing any one condition denies", () => {
  it.each([
    ["not installed (no connection row)", { installationStatus: null }],
    ["uninstalled", { uninstalledAt: new Date() }],
    ["connection not live (OAuth only, BILLING_PENDING)", { installationStatus: "BILLING_PENDING" }],
    ["connection DISCONNECTED", { installationStatus: "DISCONNECTED" }],
    ["a non-granting state", { state: "PLAN_SELECTION_REQUIRED" }],
    ["a planned entitlement missing", { entitlements: FOUR.slice(1) }],
    ["the plan unknown (nothing can be required)", { requiredEntitlements: null }],
    ["the plan funds nothing", { requiredEntitlements: [] }],
  ] as const)("%s", (_name, o) => {
    expect(v(o as any).grantsAccess).toBe(false);
  });
  it.each([
    ["not installed", { installationStatus: null }],
    ["uninstalled", { uninstalledAt: new Date() }],
    ["connection not live", { installationStatus: "BILLING_PENDING" }],
    ["a non-granting state", { state: "PAST_DUE" }],
  ] as const)("no capability either when %s", (_n, o) => {
    expect(allCaps(o as any).every((x) => x === false)).toBe(true);
  });
});

describe("each capability is gated by its own entitlement", () => {
  it.each(FOUR)("only %s held opens only %s", (key) => {
    const caps = v({ entitlements: [key] }).capabilities as Record<string, boolean>;
    for (const k of FOUR) expect(caps[k]).toBe(k === key);
    // And it is not access: the plan funds four.
    expect(v({ entitlements: [key] }).grantsAccess).toBe(false);
  });
  it("a plan that funds fewer is access with exactly those capabilities", () => {
    const r = v({ requiredEntitlements: ["shopify_catalog_sync"], entitlements: ["shopify_catalog_sync"] });
    expect(r.grantsAccess).toBe(true);
    expect(r.capabilities).toMatchObject({ shopify_catalog_sync: true, shopify_order_actions: false });
  });
  it("a row for an unknown key opens nothing", () => {
    expect(allCaps({ entitlements: ["shopify_everything"] }).every((x) => x === false)).toBe(true);
  });
});

describe("every state: access and what the screen calls it", () => {
  it.each([
    // [name, input, grantsAccess, status]
    ["no install", { installationStatus: null, entitlements: [], state: "PLAN_SELECTION_REQUIRED" }, false, "not_installed"],
    ["OAuth without the Connector", { installationStatus: "BILLING_PENDING", entitlements: [], state: "PLAN_SELECTION_REQUIRED" }, false, "authorized_not_active"],
    ["billing switched off (UNRESOLVED), OAuth live", { state: "UNRESOLVED", entitlements: [] }, false, "authorized_not_active"],
    ["PLAN_SELECTION_REQUIRED", { state: "PLAN_SELECTION_REQUIRED", installationStatus: "BILLING_PENDING", entitlements: [] }, false, "authorized_not_active"],
    ["APPROVAL_PENDING", { state: "APPROVAL_PENDING", installationStatus: "BILLING_PENDING", entitlements: [] }, false, "approval_pending"],
    ["ACTIVE", {}, true, "active"],
    ["TRIALING", { state: "TRIALING" }, true, "trialing"],
    ["CANCELLED", { state: "CANCELLED", installationStatus: "BILLING_PENDING", entitlements: [] }, false, "cancelled"],
    ["PAST_DUE", { state: "PAST_DUE", installationStatus: "BILLING_PENDING", entitlements: [] }, false, "past_due"],
    ["FROZEN", { state: "FROZEN", installationStatus: "BILLING_PENDING", entitlements: [] }, false, "frozen"],
    ["UNKNOWN_PLAN (nothing required, never access)", { state: "UNKNOWN_PLAN", installationStatus: "BILLING_PENDING", requiredEntitlements: null }, false, "error"],
    ["ERROR", { state: "ERROR", installationStatus: "BILLING_PENDING", entitlements: [] }, false, "error"],
    ["uninstall with a historical ACTIVE", { uninstalledAt: new Date(), installationStatus: "DISCONNECTED" }, false, "uninstalled"],
    ["uninstall with a historical TRIALING", { state: "TRIALING", uninstalledAt: new Date(), installationStatus: "DISCONNECTED", entitlements: [] }, false, "uninstalled"],
    ["uninstall requested, Shopify not yet confirmed", { uninstallRequestedAt: new Date() }, true, "uninstall_pending"],
    ["ACTIVE without the entitlement rows (our drift)", { entitlements: [] }, false, "error"],
    ["entitlement rows with the store disconnected", { installationStatus: "DISCONNECTED", uninstalledAt: new Date() }, false, "uninstalled"],
    ["the grandfather exemption with all four", { state: "NOT_REQUIRED_GRANDFATHERED" }, true, "active"],
  ] as const)("%s", (_n, o, grants, status) => {
    const r = v(o as any);
    expect([r.grantsAccess, r.status]).toEqual([grants, status]);
  });
});

describe("the seven order tools are order actions (split billing 2026-10-28)", () => {
  it.each(["cancel_order", "create_return", "exchange_order_item", "process_refund", "resend_confirmation", "send_invoice", "update_order_shipping_address"])(
    "%s needs shopify_order_actions, in both name shapes",
    async (tool) => {
      const { shopifyCapabilityForTool } = await import("../lib/billing/shopify-capability-map");
      expect(shopifyCapabilityForTool(tool)).toBe("shopify_order_actions");
      expect(shopifyCapabilityForTool(`shopify.${tool}`)).toBe("shopify_order_actions");
    },
  );
});
