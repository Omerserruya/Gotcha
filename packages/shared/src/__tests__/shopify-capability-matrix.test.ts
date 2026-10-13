/**
 * NEGATIVE MATRIX: one funded entitlement must not unlock the other three.
 *
 * The Connector grants a set, and a plan may grant a subset. "Has a Shopify
 * row" is not authorization - a merchant funded only for catalogue sync must
 * not be able to read a customer's order history or issue a refund. Every cell
 * of this matrix is asserted, including the 12 that must DENY.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({ rows: [] as any[] }));
const prismaMock = vi.hoisted(() => ({
  tenantEntitlement: {
    findMany: vi.fn(async ({ where }: any) =>
      db.rows.filter((r: any) =>
        r.tenantId === where.tenantId &&
        (!where.entitlementKey?.in || where.entitlementKey.in.includes(r.entitlementKey)) &&
        (!where.source?.in || where.source.in.includes(r.source)),
      ),
    ),
  },
}));
vi.mock("../lib/prisma", () => ({ prisma: prismaMock }));

import { isShopifyAuthorized, SHOPIFY_FUNDED_ENTITLEMENTS } from "../lib/billing/shopify-authorization";
import {
  shopifyCapabilityForTool,
  MAPPED_SHOPIFY_TOOLS,
  SHOPIFY_OPERATION,
} from "../lib/billing/shopify-capability-map";

const TENANT = "t_matrix";
const CAPS = [...SHOPIFY_FUNDED_ENTITLEMENTS];

function grantOnly(key: string, source = "SHOPIFY_SUBSCRIPTION", over: Partial<any> = {}) {
  db.rows = [{ tenantId: TENANT, entitlementKey: key, value: true, source, expiresAt: null, ...over }];
}

beforeEach(() => { db.rows = []; });

describe("one entitlement does not unlock the others", () => {
  for (const granted of CAPS) {
    for (const asked of CAPS) {
      const shouldPass = granted === asked;
      it(`granted ${granted} -> ${asked} is ${shouldPass ? "ALLOWED" : "DENIED"}`, async () => {
        grantOnly(granted);
        expect(await isShopifyAuthorized(TENANT, asked as any)).toBe(shouldPass);
      });
    }
  }

  it("a grandfather grant is also per-capability, not a master key", async () => {
    grantOnly("shopify_catalog_sync", "SHOPIFY_GRANDFATHERED");
    expect(await isShopifyAuthorized(TENANT, "shopify_catalog_sync")).toBe(true);
    expect(await isShopifyAuthorized(TENANT, "shopify_order_actions")).toBe(false);
    expect(await isShopifyAuthorized(TENANT, "shopify_order_read")).toBe(false);
    expect(await isShopifyAuthorized(TENANT, "shopify_storefront_widget")).toBe(false);
  });
});

describe("each accepted row must satisfy every condition", () => {
  it("wrong tenant is rejected", async () => {
    grantOnly("shopify_order_read");
    db.rows[0].tenantId = "other";
    expect(await isShopifyAuthorized(TENANT, "shopify_order_read")).toBe(false);
  });

  it("a different key does not satisfy the required one", async () => {
    grantOnly("shopify_catalog_sync");
    expect(await isShopifyAuthorized(TENANT, "shopify_order_read")).toBe(false);
  });

  it("value false is rejected", async () => {
    grantOnly("shopify_order_read", "SHOPIFY_SUBSCRIPTION", { value: false });
    expect(await isShopifyAuthorized(TENANT, "shopify_order_read")).toBe(false);
  });

  it("an expired row is rejected", async () => {
    grantOnly("shopify_order_read", "SHOPIFY_SUBSCRIPTION", { expiresAt: new Date(Date.now() - 1) });
    expect(await isShopifyAuthorized(TENANT, "shopify_order_read")).toBe(false);
  });

  it("a revoked row (deleted, which is how revocation works) is rejected", async () => {
    grantOnly("shopify_order_read");
    expect(await isShopifyAuthorized(TENANT, "shopify_order_read")).toBe(true);
    db.rows = []; // revokeShopifyEntitlements uses deleteMany
    expect(await isShopifyAuthorized(TENANT, "shopify_order_read")).toBe(false);
  });

  it.each(["PLAN_DEFAULT", "OVERRIDE", "PROMO", "TRIAL", "BETA", "ADDON", "VOLUME_OPTION"])(
    "source %s is rejected even with the exact key",
    async (source) => {
      grantOnly("shopify_order_read", source);
      expect(await isShopifyAuthorized(TENANT, "shopify_order_read")).toBe(false);
    },
  );
});

describe("tool classification", () => {
  it("catalogue reads require catalog_sync", () => {
    for (const t of ["get_product", "search_products", "inventory_status", "variant_information"]) {
      expect(shopifyCapabilityForTool(t)).toBe(SHOPIFY_OPERATION.CATALOG);
    }
  });

  it("order and customer reads require order_read", () => {
    for (const t of ["get_order", "get_customer_orders", "check_refund", "track_shipment", "order_lookup"]) {
      expect(shopifyCapabilityForTool(t)).toBe(SHOPIFY_OPERATION.ORDER_CONTEXT);
    }
  });

  it("every mutation requires order_actions", () => {
    for (const t of ["update_customer", "create_discount_code", "update_order_fulfillment", "add_tag"]) {
      expect(shopifyCapabilityForTool(t)).toBe(SHOPIFY_OPERATION.ORDER_ACTION);
    }
  });

  it("accepts the dotted dispatch form as well as the bare slug", () => {
    expect(shopifyCapabilityForTool("shopify.get_order")).toBe(SHOPIFY_OPERATION.ORDER_CONTEXT);
  });

  // Fail-closed: a tool added later with no entry must be denied, not defaulted.
  it("an unknown tool is unclassified, which callers treat as deny", () => {
    expect(shopifyCapabilityForTool("shopify.some_new_tool")).toBeNull();
    expect(shopifyCapabilityForTool("delete_everything")).toBeNull();
  });

  it("no tool is classified into two groups", () => {
    expect(new Set(MAPPED_SHOPIFY_TOOLS).size).toBe(MAPPED_SHOPIFY_TOOLS.length);
  });

  // Drift guard: if the adapter gains a tool, this fails until it is classified.
  it("every tool the Shopify adapter exposes is classified", async () => {
    const fs = await import("node:fs");
    const path = new URL(
      "../../../../services/ai/src/services/connectors/shopify.adapter.ts",
      import.meta.url,
    ).pathname;
    if (!fs.existsSync(path)) return; // packages/shared is publishable alone
    const src = fs.readFileSync(path, "utf8");
    const body = src.slice(src.indexOf("const TOOLS: ToolDefinition[] = ["));
    const slugs = [...body.matchAll(/\bt\("([a-z0-9_]+)",\s*"(?:READ|WRITE)"/g)].map((m) => m[1]);
    expect(slugs.length).toBeGreaterThan(50);
    const unclassified = slugs.filter((s) => shopifyCapabilityForTool(s) === null);
    expect(unclassified, `unclassified Shopify tools: ${unclassified.join(", ")}`).toEqual([]);
  });
});
