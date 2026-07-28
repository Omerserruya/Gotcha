/**
 * Shopify catalog + cart validation.
 *
 * This is where "prices and inventory come from Shopify" is either true
 * or a slogan. The adapter is stubbed at the tool-dispatch boundary, so
 * the snapshotting, store-binding and variant-membership logic under
 * test is the real thing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("bullmq", () => ({ Queue: class { add = vi.fn(); }, Worker: class {}, Job: class {} }));
vi.mock("ioredis", () => ({ default: class { publish = vi.fn(); on = vi.fn(); subscribe = vi.fn(); quit = vi.fn(); } }));
vi.mock("@prisma/client", () => ({ PrismaClient: class { $extends() { return this; } } }));

const H = vi.hoisted(() => {
  const v: any = vi;
  return {
    execute: v.fn(),
    connection: { current: null as any },
  };
});

vi.mock("../services/connectors/integration-framework", () => ({
  executeAdapterTool: H.execute,
  loadConnection: vi.fn(async () => H.connection.current),
}));

import {
  resolveShopifyStore,
  probeProductCapability,
  searchCatalog,
  getProductSnapshot,
  getProductSnapshots,
  validateCartLine,
  __resetShopifyCatalogCache,
} from "../services/shopify-catalog.service";

const SHOP = "demo-store.myshopify.com";

const PRODUCT = {
  id: 111,
  title: "Cloud Pro Runner",
  handle: "cloud-pro-runner",
  status: "active",
  vendor: "Cloudline",
  image: { src: "https://cdn.shopify.com/s/files/1/cloud.jpg" },
  options: [{ name: "Size" }],
  variants: [
    { id: 9001, title: "41", price: "120.00", compare_at_price: "150.00", available: true, option1: "41" },
    { id: 9002, title: "42", price: "120.00", compare_at_price: null, available: false, option1: "42" },
  ],
};

/** Route each tool name to a canned answer, like the adapter would. */
function adapter(map: Record<string, any>) {
  H.execute.mockImplementation(async ({ toolFunctionName }: any) => {
    if (!(toolFunctionName in map)) return { ok: false, reason: `unstubbed:${toolFunctionName}` };
    const value = map[toolFunctionName];
    return value instanceof Error ? { ok: false, reason: value.message } : { ok: true, result: value };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetShopifyCatalogCache();
  H.connection.current = {
    tenantIntegrationId: "ti1",
    credentials: { accessToken: "shpat_secret" },
    config: { shopDomain: SHOP },
    status: "CONNECTED",
    expiresAt: null,
  };
  adapter({
    "shopify.get_shop": { name: "Demo", currency: "ils", myshopify_domain: SHOP },
    "shopify.search_products": [PRODUCT],
    "shopify.get_product": PRODUCT,
  });
});

// ─── Store resolution ───────────────────────────────────────

describe("store resolution", () => {
  it("resolves the bound store and its currency", () => {
    return resolveShopifyStore("t1").then((r) => {
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.store.shopDomain).toBe(SHOP);
      expect(r.store.currency).toBe("ILS");
    });
  });

  it("caches shop metadata rather than paying for it per card", async () => {
    await resolveShopifyStore("t1");
    await resolveShopifyStore("t1");
    const shopCalls = H.execute.mock.calls.filter((c: any[]) => c[0].toolFunctionName === "shopify.get_shop");
    expect(shopCalls).toHaveLength(1);
  });

  it("reports not_connected rather than guessing", async () => {
    H.connection.current = null;
    const r = await resolveShopifyStore("t1");
    expect(r).toEqual({ ok: false, reason: "not_connected" });
  });

  it("refuses a connection whose shop domain is not a real myshopify host", async () => {
    H.connection.current = { ...H.connection.current, config: { shopDomain: "evil.com" }, credentials: {} };
    const r = await resolveShopifyStore("t1");
    expect(r).toEqual({ ok: false, reason: "no_shop_domain" });
  });
});

// ─── Capability probe ───────────────────────────────────────

describe("product capability", () => {
  it("passes when products read cleanly", async () => {
    // (case 4 / 38)
    expect(await probeProductCapability("t1")).toEqual({ ok: true });
  });

  it("names a missing scope so the merchant can fix it", async () => {
    // (case 42) Text chat must survive; only product messaging degrades.
    adapter({
      "shopify.get_shop": { currency: "USD" },
      "shopify.search_products": new Error("shopify_403: access denied for read_products"),
    });
    const r = await probeProductCapability("t1");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("missing_scope");
    expect(r.detail).toMatch(/read_products/);
  });

  it("reports an unreachable store without leaking the raw error", async () => {
    adapter({
      "shopify.get_shop": { currency: "USD" },
      "shopify.search_products": new Error("ECONNRESET at 10.0.0.5:443"),
    });
    const r = await probeProductCapability("t1");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("unreachable");
    expect(r.detail).not.toContain("10.0.0.5");
  });
});

// ─── Search + snapshots ─────────────────────────────────────

describe("catalog search", () => {
  it("returns snapshots stamped with the bound store", async () => {
    // (case 38) A recommendation is based on live Shopify data.
    const r = await searchCatalog({ tenantId: "t1", query: "runner" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toHaveLength(1);
    expect(r.data[0].shopDomain).toBe(SHOP);
    expect(r.data[0].price).toBe("120.00");
    expect(r.data[0].currency).toBe("ILS");
  });

  it("asks Shopify for active products only unless told otherwise", async () => {
    await searchCatalog({ tenantId: "t1", query: "x" });
    const call = H.execute.mock.calls.find((c: any[]) => c[0].toolFunctionName === "shopify.search_products");
    expect(call[0].args.status).toBe("active");

    await searchCatalog({ tenantId: "t1", query: "x", includeUnpublished: true });
    const second = H.execute.mock.calls.filter((c: any[]) => c[0].toolFunctionName === "shopify.search_products").pop();
    expect(second[0].args.status).toBe("any");
  });

  it("filters out unpublished products by policy", async () => {
    // (case 30)
    adapter({
      "shopify.get_shop": { currency: "USD" },
      "shopify.search_products": [{ ...PRODUCT, status: "draft" }],
    });
    const strict = await searchCatalog({ tenantId: "t1", query: "x" });
    expect(strict.ok && strict.data).toHaveLength(0);

    const permissive = await searchCatalog({ tenantId: "t1", query: "x", includeUnpublished: true });
    expect(permissive.ok && permissive.data).toHaveLength(1);
    expect(permissive.ok && permissive.data[0].status).toBe("draft");
  });

  it("never carries a Shopify credential into a snapshot", async () => {
    // (case 37)
    const r = await searchCatalog({ tenantId: "t1", query: "x" });
    expect(JSON.stringify(r)).not.toContain("shpat_");
    expect(JSON.stringify(r)).not.toContain("accessToken");
  });

  it("passes the store's failure through instead of inventing results", async () => {
    adapter({ "shopify.get_shop": { currency: "USD" }, "shopify.search_products": new Error("shopify_500") });
    const r = await searchCatalog({ tenantId: "t1", query: "x" });
    expect(r.ok).toBe(false);
  });
});

describe("product lookup", () => {
  it("resolves by handle for the current storefront page", async () => {
    // (case 41) Current-product context is resolved server-side.
    const r = await getProductSnapshot({ tenantId: "t1", handle: "cloud-pro-runner" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data!.title).toBe("Cloud Pro Runner");
    const call = H.execute.mock.calls.find((c: any[]) => c[0].toolFunctionName === "shopify.get_product");
    expect(call[0].args.handle).toBe("cloud-pro-runner");
  });

  it("requires an id or a handle", async () => {
    const r = await getProductSnapshot({ tenantId: "t1" });
    expect(r).toEqual({ ok: false, reason: "product_id_or_handle_required" });
  });

  it("drops references that no longer resolve instead of failing the batch", async () => {
    // (case 29) One dead product must not blank an entire carousel.
    let call = 0;
    H.execute.mockImplementation(async ({ toolFunctionName }: any) => {
      if (toolFunctionName === "shopify.get_shop") return { ok: true, result: { currency: "USD" } };
      if (toolFunctionName === "shopify.get_product") {
        call++;
        return call === 1 ? { ok: false, reason: "shopify_404" } : { ok: true, result: PRODUCT };
      }
      return { ok: false, reason: "unstubbed" };
    });
    const r = await getProductSnapshots("t1", [{ productId: "999" }, { productId: "111" }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toHaveLength(1);
    expect(r.data[0].productId).toBe("111");
  });
});

// ─── Cart validation ────────────────────────────────────────

describe("cart validation", () => {
  const base = { tenantId: "t1", expectedShopDomain: SHOP, productId: "111", variantId: "9001", quantity: 1 };

  it("returns Shopify's price, not the caller's", async () => {
    // (cases 27, 28, 31)
    const r = await validateCartLine({ ...base, quantity: 2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.variantId).toBe("9001");
    expect(r.quantity).toBe(2);
    expect(r.price).toBe("120.00");
    expect(r.currency).toBe("ILS");
  });

  it("refuses a variant that belongs to a different product", async () => {
    // (case 32) Membership, not existence: a valid-looking id from
    // another product must not be smuggled in.
    const r = await validateCartLine({ ...base, variantId: "8888" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("variant_not_found");
  });

  it("refuses an out-of-stock variant", async () => {
    // (case 26)
    const r = await validateCartLine({ ...base, variantId: "9002" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("variant_unavailable");
  });

  it("refuses when the connected store is not the channel's store", async () => {
    // (cases 24, 33) Cross-store add-to-cart is unrepresentable.
    const r = await validateCartLine({ ...base, expectedShopDomain: "someone-else.myshopify.com" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("store_mismatch");
  });

  it("validates quantity", async () => {
    // (case 34)
    for (const quantity of [0, -1, 1.5, 999, Number.NaN]) {
      const r = await validateCartLine({ ...base, quantity });
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.code).toBe("invalid_quantity");
    }
  });

  it("refuses a product that vanished mid-conversation", async () => {
    // (case 29)
    adapter({ "shopify.get_shop": { currency: "USD" }, "shopify.get_product": new Error("shopify_404") });
    const r = await validateCartLine(base);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("product_not_found");
  });

  it("refuses an unpublished product unless policy allows it", async () => {
    // (case 30)
    adapter({ "shopify.get_shop": { currency: "USD" }, "shopify.get_product": { ...PRODUCT, status: "draft" } });
    const strict = await validateCartLine(base);
    expect(strict.ok).toBe(false);
    if (!strict.ok) expect(strict.code).toBe("product_unpublished");

    const permissive = await validateCartLine({ ...base, allowUnpublished: true });
    expect(permissive.ok).toBe(true);
  });

  it("sends a selling-plan product to its product page instead of the cart", async () => {
    adapter({
      "shopify.get_shop": { currency: "USD" },
      "shopify.get_product": {
        ...PRODUCT,
        variants: [{ id: 9001, title: "41", price: "120.00", available: true, requires_selling_plan: true }],
      },
    });
    const r = await validateCartLine(base);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("selling_plan_required");
  });

  it("never surfaces a raw Shopify error to a shopper", async () => {
    // (case 35)
    adapter({
      "shopify.get_shop": { currency: "USD" },
      "shopify.get_product": new Error("shopify_500: {\"errors\":\"internal at db-3.shopify.io\"}"),
    });
    const r = await validateCartLine(base);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.detail).not.toContain("shopify.io");
    expect(r.detail).not.toContain("500");
  });
});
