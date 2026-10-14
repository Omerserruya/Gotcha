/**
 * ★ W9 phase a: WooCommerce product search grounded like Shopify's.
 *   - the envelope from Woo's own fields; the link only from the store's host;
 *     hidden / unpublished dropped; the store's currency, never the shopper's
 *   - a product tool is grounded against ITS store: woocommerce.* against the
 *     Woo connection (it used to be normalised against the Shopify domain),
 *     other providers' get_product not at all
 *   - the store currency is read once and cached on the connection
 *   - list_products asks Woo for published products in the price / stock range
 *   - discovery counts the Woo search (a Woo-only sales employee was "blocked")
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const H = vi.hoisted(() => ({
  conns: {} as Record<string, any>,
  updates: [] as any[],
  facts: new Map<string, any>(),
  fetches: [] as string[],
  currency: { code: "ILS" } as any,
}));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    assertPublicUrl: vi.fn(async () => undefined),
    getOrCreateActiveSession: async () => ({ id: "sess1" }),
    activeFacts: async () => H.facts,
    prisma: {
      tenantIntegration: {
        findFirst: async (a: any) => {
          const c = H.conns[a.where.integration.slug];
          return c && a.where.tenantId === "T" ? { id: c.id, config: c.config } : null;
        },
        update: async (a: any) => { H.updates.push(a); return {}; },
      },
    },
  };
});
vi.mock("../services/connectors/integration-framework", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  loadConnection: async (o: any) => {
    const c = H.conns[o.slug];
    return c && o.tenantId === "T" ? { tenantIntegrationId: c.id, credentials: { consumerKey: "ck", consumerSecret: "cs" }, config: c.config, status: "CONNECTED", expiresAt: null } : null;
  },
  executeAdapterTool: async () => ({ ok: true, result: { currency: "USD" } }),
}));

import { normalizeWooProducts } from "../services/product-search.service";
import { groundProductSearchResult, productSearchProviderOf, isProductSearchTool, productToolAvailable, productDiscoveryApplies, enrichProductSearchArgs } from "../services/discovery-integration.service";
import Woo, { fetchWooStoreCurrency } from "../services/connectors/woocommerce.adapter";

const STORE = "https://demo-store.example.com";
const woo = (o: any = {}) => ({
  id: 41, name: "Oak Lamp", status: "publish", catalog_visibility: "visible", type: "simple", sku: "OAK-1",
  price: "149.90", stock_status: "instock", permalink: `${STORE}/product/oak-lamp/`,
  images: [{ src: `${STORE}/wp-content/uploads/oak.jpg` }], categories: [{ name: "Lighting" }], ...o,
});

beforeEach(() => {
  H.conns = { woocommerce: { id: "ti_woo", config: { storeUrl: STORE } } };
  H.updates = []; H.facts = new Map(); H.fetches = []; H.currency = { code: "ILS" };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    H.fetches.push(url);
    const body = url.includes("/data/currencies/current") ? H.currency : [woo(), woo({ id: 42, name: "Hidden", catalog_visibility: "hidden" })];
    return { ok: true, status: 200, json: async () => body, text: async () => "" };
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("★ normalizeWooProducts", () => {
  it("Woo's fields into the envelope, in the store's currency", () => {
    const env = normalizeWooProducts([woo()], { storeUrl: STORE, storeCurrency: "ILS", requestedFilters: ["query"] });
    expect(env).toMatchObject({ provider: "woocommerce", tool: "woocommerce_product_search", status: "ok", appliedFilters: ["query"] });
    expect(env.candidates).toEqual([{
      title: "Oak Lamp", productId: "41", variantId: undefined, sku: "OAK-1", price: "149.90", currency: "ILS",
      inventoryState: "in_stock", url: `${STORE}/product/oak-lamp/`, imageUrl: `${STORE}/wp-content/uploads/oak.jpg`,
      attributes: { product_type: "simple", category: "Lighting" }, unknownAttributes: [], matchQuality: "exact",
    }]);
  });

  it("★ a link off the store's host is replaced by the store's own; hidden / unpublished dropped; stock states", () => {
    const env = normalizeWooProducts([
      woo({ permalink: "https://evil.example.com/phish" }),
      woo({ id: 2, catalog_visibility: "hidden" }),
      woo({ id: 3, status: "draft" }),
      woo({ id: 4, stock_status: "outofstock" }),
      woo({ id: 5, stock_status: "onbackorder" }),
    ], { storeUrl: STORE + "/" });
    expect(env.candidates.map((c) => c.productId)).toEqual(["41", "4", "5"]);
    expect(env.candidates[0]!.url).toBe(`${STORE}/?p=41`);
    expect(env.candidates.map((c) => c.inventoryState)).toEqual(["in_stock", "out_of_stock", "in_stock"]);
    expect(normalizeWooProducts([], { storeUrl: STORE }).status).toBe("no_results");
  });

  it("a budget in another currency is not compared, and said so", () => {
    const env = normalizeWooProducts([woo()], { storeUrl: STORE, storeCurrency: "ILS", budget: { target: 100, currency: "USD" } });
    expect(env.budgetCurrencyMismatch).toEqual({ budget: "USD", shop: "ILS" });
    expect(env.budget).toBeUndefined();
    const same = normalizeWooProducts([woo()], { storeUrl: STORE, storeCurrency: "ILS", budget: { target: 100, currency: "ILS" } });
    expect(same.candidates[0]!.matchQuality).toBe("approximate");
  });
});

describe("★ each product tool grounded against its own store", () => {
  it("which store a tool reads", () => {
    expect(productSearchProviderOf("shopify.search_products")).toBe("shopify");
    expect(productSearchProviderOf("get_product")).toBe("shopify");
    expect(productSearchProviderOf("woocommerce.list_products")).toBe("woocommerce");
    expect(productSearchProviderOf("woocommerce.get_product")).toBe("woocommerce");
    for (const t of ["wix.get_product", "wix.list_products", "woocommerce.list_orders", undefined]) expect(isProductSearchTool(t as any)).toBe(false);
  });

  it("★ woocommerce.get_product on a tenant with BOTH stores: the Woo store, never the Shopify domain", async () => {
    H.conns.shopify = { id: "ti_shop", config: { shopDomain: "x.myshopify.com", shopCurrency: "USD" } };
    const env = await groundProductSearchResult({ tenantId: "T", conversationId: "c1", toolName: "woocommerce.get_product", rawContent: JSON.stringify(woo()) });
    expect(env!.provider).toBe("woocommerce");
    expect(env!.candidates[0]).toMatchObject({ productId: "41", url: `${STORE}/product/oak-lamp/`, currency: "ILS" });
    expect(JSON.stringify(env)).not.toContain("myshopify");
  });

  it("★ the store currency is read once and cached on the Woo connection", async () => {
    await groundProductSearchResult({ tenantId: "T", conversationId: "c1", toolName: "woocommerce.list_products", rawContent: JSON.stringify([woo()]) });
    expect(H.fetches).toEqual([`${STORE}/wp-json/wc/v3/data/currencies/current`]);
    expect(H.updates).toEqual([{ where: { id: "ti_woo" }, data: { config: { storeUrl: STORE, storeCurrency: "ILS" } } }]);
    H.conns.woocommerce.config = { storeUrl: STORE, storeCurrency: "ILS" };
    H.fetches = [];
    await groundProductSearchResult({ tenantId: "T", conversationId: "c1", toolName: "woocommerce.list_products", rawContent: JSON.stringify([woo()]) });
    expect(H.fetches).toEqual([]);
  });

  it("a failed call is an error envelope of the right store; no Woo connection grounds nothing", async () => {
    expect(await groundProductSearchResult({ tenantId: "T", conversationId: "c1", toolName: "woocommerce.list_products", rawContent: JSON.stringify({ ok: false }) }))
      .toMatchObject({ provider: "woocommerce", status: "error" });
    H.conns = {};
    expect(await groundProductSearchResult({ tenantId: "T", conversationId: "c1", toolName: "woocommerce.list_products", rawContent: "[]" })).toBeNull();
    expect(await groundProductSearchResult({ tenantId: "T", conversationId: "c1", toolName: "wix.get_product", rawContent: "{}" })).toBeNull();
  });

  it("the conversation's budget becomes price_max on the Woo search, in the store's currency only", async () => {
    H.conns.woocommerce.config = { storeUrl: STORE, storeCurrency: "ILS" };
    H.facts = new Map([["budget", { valueJson: "500 ש\"ח" }]]);
    expect(await enrichProductSearchArgs({ tenantId: "T", conversationId: "c1", toolName: "woocommerce.list_products", args: { query: "lamp" } }))
      .toEqual({ query: "lamp", price_max: 500 });
    for (const v of ["עד 500 ש״ח", "500 NIS", "500 ₪"]) {
      H.facts = new Map([["budget", { valueJson: v }]]);
      expect((await enrichProductSearchArgs({ tenantId: "T", conversationId: "c1", toolName: "woocommerce.list_products", args: {} })).price_max).toBe(500);
    }
    H.facts = new Map([["budget", { valueJson: "500 USD" }]]);
    expect(await enrichProductSearchArgs({ tenantId: "T", conversationId: "c1", toolName: "woocommerce.list_products", args: { query: "lamp" } }))
      .toEqual({ query: "lamp" });
  });
});

describe("★ the Woo search asks the store for what it shows", () => {
  const run = (args: any) => Woo.execute({ toolName: "list_products", args, credentials: { consumerKey: "ck", consumerSecret: "cs" }, config: { storeUrl: STORE } } as any);
  it("published only, the price range and stock passed to Woo; hidden products dropped", async () => {
    const out: any = await run({ query: "lamp", price_min: 50, price_max: 500, in_stock: true });
    const u = new URL(H.fetches[0]!);
    expect(u.pathname).toBe("/wp-json/wc/v3/products");
    expect(Object.fromEntries(u.searchParams)).toEqual({ per_page: "10", search: "lamp", status: "publish", min_price: "50", max_price: "500", stock_status: "instock" });
    expect(out.map((p: any) => p.id)).toEqual([41]);
  });
  it("junk prices are not sent", async () => {
    await run({ price_max: "abc", price_min: -5, in_stock: "yes" });
    expect(Object.fromEntries(new URL(H.fetches[0]!).searchParams)).toEqual({ per_page: "10", status: "publish" });
  });
  it("the store currency: an ISO code, else null", async () => {
    expect(await fetchWooStoreCurrency({ consumerKey: "ck", consumerSecret: "cs" }, { storeUrl: STORE })).toBe("ILS");
    H.currency = { code: "shekels" };
    expect(await fetchWooStoreCurrency({ consumerKey: "ck", consumerSecret: "cs" }, { storeUrl: STORE })).toBeNull();
    expect(await fetchWooStoreCurrency({}, { storeUrl: STORE })).toBeNull();
  });
});

describe("★ discovery counts the Woo search", () => {
  it("a Woo-only surface can execute; a Shopify search still comes first", () => {
    expect(productToolAvailable(["woocommerce.list_products", "woocommerce.get_order"])).toEqual({ available: true, tool: "woocommerce.list_products" });
    expect(productToolAvailable(["woocommerce.list_products", "shopify.search_products"]).tool).toBe("shopify.search_products");
    expect(productToolAvailable(["woocommerce.get_product"]).available).toBe(false);
    expect(productDiscoveryApplies({ role: "customer_support", availableToolNames: ["woocommerce.list_products"] })).toBe(true);
  });
});
