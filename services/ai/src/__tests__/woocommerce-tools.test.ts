/**
 * WooCommerce tools against a stubbed store (no network). Write tools are
 * tested only like this; the real dev store gets read-only tools.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const R = vi.hoisted(() => ({ kv: new Map<string, string>() }));
vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    assertPublicUrl: vi.fn(async () => undefined),
    getRedis: () => ({
      get: async (k: string) => R.kv.get(k) ?? null,
      set: async (k: string, v: string) => { R.kv.set(k, v); return "OK"; },
    }),
  };
});

import Woo from "../services/connectors/woocommerce.adapter";

const H = vi.hoisted(() => ({ calls: [] as Array<{ url: string; method: string; body: any }> }));
const run = (toolName: string, args: Record<string, unknown>) =>
  Woo.execute({ toolName, args, credentials: { consumerKey: "ck", consumerSecret: "cs" }, config: { storeUrl: "https://shop.example.com" } } as any);

beforeEach(() => {
  H.calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
    H.calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, json: async () => ({ id: 1, url }), text: async () => "" };
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("update_order_status", () => {
  it("★ a note becomes an order note the customer sees; the customer's own note is untouched", async () => {
    await run("update_order_status", { order_id: "1001", status: "completed", note: "Shipped today" });
    expect(H.calls).toEqual([
      { url: "https://shop.example.com/wp-json/wc/v3/orders/1001", method: "PUT", body: { status: "completed" } },
      { url: "https://shop.example.com/wp-json/wc/v3/orders/1001/notes", method: "POST", body: { note: "Shipped today", customer_note: true } },
    ]);
  });

  it("no note: one PUT", async () => {
    await run("update_order_status", { order_id: "1001", status: "processing" });
    expect(H.calls.map((c) => c.method)).toEqual(["PUT"]);
  });
});

import { CATALOG_TOOL_HE } from "../lib/catalog-tools-he";
describe("Hebrew for every adapter tool (A5)", () => {
  it("every WooCommerce tool has a Hebrew name and description", () => {
    for (const t of Woo.tools()) {
      const slug = t.name.slice(t.name.indexOf(".") + 1);
      const he = (CATALOG_TOOL_HE as any)[`woocommerce:${slug}`];
      expect(he?.name, slug).toBeTruthy();
      expect(he?.description, slug).toBeTruthy();
    }
  });
  it("the three Shopify tools that had none now do", () => {
    for (const slug of ["get_shop", "complementary_products", "get_product_images"]) expect((CATALOG_TOOL_HE as any)[`shopify:${slug}`]?.name, slug).toBeTruthy();
  });
});

import { riskGroupFor } from "@chatcenter/shared";

describe("★ the new WooCommerce tools (2026-10-13), stubbed store", () => {
  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => "" });
  const store = (byKey: Record<string, unknown>, missing: string[] = []) => {
    H.calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
      H.calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
      const u = new URL(url);
      const key = `${init.method} ${u.pathname.replace("/wp-json/wc/v3", "")}`;
      if (missing.includes(key)) return { ok: false, status: 404, json: async () => ({}), text: async () => "rest_no_route" };
      return ok(byKey[key] ?? {});
    }));
  };
  const B = "https://shop.example.com/wp-json/wc/v3";

  it("create_refund: through the gateway, amount validated", async () => {
    store({});
    await run("create_refund", { order_id: "1001", amount: "49.90", reason: "damaged" });
    expect(H.calls[0]).toEqual({ url: `${B}/orders/1001/refunds`, method: "POST", body: { amount: "49.90", reason: "damaged", api_refund: true } });
    await expect(run("create_refund", { order_id: "1001", amount: "-5" })).rejects.toThrow("invalid_refund_amount");
    await expect(run("create_refund", { order_id: "1001", amount: "abc" })).rejects.toThrow("invalid_refund_amount");
  });

  it("cancel_order: refuses a completed order; cancels an open one and tells the customer", async () => {
    store({ "GET /orders/5": { id: 5, status: "completed" } });
    await expect(run("cancel_order", { order_id: "5" })).rejects.toThrow("order_not_cancellable:completed");
    expect(H.calls.map((c) => c.method)).toEqual(["GET"]);
    store({ "GET /orders/6": { id: 6, status: "processing" } });
    await run("cancel_order", { order_id: "6", note: "Cancelled as requested" });
    expect(H.calls.map((c) => `${c.method} ${new URL(c.url).pathname.split("/v3")[1]}`)).toEqual(["GET /orders/6", "PUT /orders/6", "POST /orders/6/notes"]);
    expect(H.calls[1].body).toEqual({ status: "cancelled" });
  });

  it("update_shipping_address: only the given fields, not on a shipped order", async () => {
    store({ "GET /orders/7": { id: 7, status: "processing" } });
    await run("update_shipping_address", { order_id: "7", address_1: " Herzl 1 ", city: "Tel Aviv", phone: "" });
    expect(H.calls[1].body).toEqual({ shipping: { address_1: "Herzl 1", city: "Tel Aviv" } });
    store({ "GET /orders/8": { id: 8, status: "completed" } });
    await expect(run("update_shipping_address", { order_id: "8", address_1: "x", city: "y" })).rejects.toThrow("order_already_completed");
  });

  it("add_order_note: private unless asked to be customer-visible", async () => {
    store({});
    await run("add_order_note", { order_id: "9", note: "Checked stock" });
    expect(H.calls[0].body).toEqual({ note: "Checked stock", customer_note: false });
  });

  it("get_coupon: exists, valid, expired, used up, disabled, missing", async () => {
    const future = new Date(Date.now() + 86400000).toISOString().slice(0, 19);
    const past = new Date(Date.now() - 86400000).toISOString().slice(0, 19);
    const cases: Array<[any, any]> = [
      [[{ code: "a", status: "publish", date_expires_gmt: future, usage_count: 0, usage_limit: 5, amount: "10", discount_type: "percent" }], { valid: true, reason: null }],
      [[{ code: "a", status: "publish", date_expires_gmt: past }], { valid: false, reason: "expired" }],
      [[{ code: "a", status: "publish", usage_count: 5, usage_limit: 5 }], { valid: false, reason: "used_up" }],
      [[{ code: "a", status: "draft" }], { valid: false, reason: "disabled" }],
      [[], { exists: false, valid: false, reason: "not_found" }],
    ];
    for (const [list, want] of cases) {
      store({ "GET /coupons": list });
      expect(await run("get_coupon", { code: "a" }), JSON.stringify(list)).toMatchObject(want);
    }
  });

  it("disable_coupon by code: found, then set to draft (not deleted)", async () => {
    store({ "GET /coupons": [{ id: 44, code: "x" }] });
    await run("disable_coupon", { code: "x" });
    expect(H.calls[1]).toMatchObject({ url: `${B}/coupons/44`, method: "PUT", body: { status: "draft" } });
  });

  it("create_coupon: fixed amount when asked, percent by default", async () => {
    store({});
    await run("create_coupon", { code: "TEN", amount: "10", discount_type: "fixed_cart" });
    expect(H.calls[0].body.discount_type).toBe("fixed_cart");
    await run("create_coupon", { code: "P", amount: "10" });
    expect(H.calls[1].body.discount_type).toBe("percent");
  });

  it("list_customer_orders: by customer id, else by phone / email, newest first", async () => {
    store({});
    await run("list_customer_orders", { customer_id: "7" });
    const u = new URL(H.calls[0].url);
    expect([u.searchParams.get("customer"), u.searchParams.get("orderby"), u.searchParams.get("order")]).toEqual(["7", "date", "desc"]);
    await expect(run("list_customer_orders", {})).rejects.toThrow("phone_email_or_customer_id_required");
  });

  it("★ get_shipment_tracking asks the extension's own namespace, and a 200 records the store as having it", async () => {
    R.kv.clear();
    store({});
    await run("get_shipment_tracking", { order_id: "3" });
    expect(H.calls[0].url).toBe("https://shop.example.com/wp-json/wc-shipment-tracking/v3/orders/3/shipment-trackings");
    await new Promise((r) => setTimeout(r, 0));
    expect(R.kv.get("woo:shipment-tracking:https://shop.example.com")).toBe("1");
  });

  it("★ get_shipment_tracking: without the extension, says so instead of failing, and the store is recorded as without it", async () => {
    R.kv.clear();
    store({}, ["GET /wp-json/wc-shipment-tracking/v3/orders/3/shipment-trackings"]);
    expect(await run("get_shipment_tracking", { order_id: "3" })).toMatchObject({ supported: false });
    await new Promise((r) => setTimeout(r, 0));
    expect(R.kv.get("woo:shipment-tracking:https://shop.example.com")).toBe("0");
  });

  it("get_shipment_tracking: a 404 for an unknown order is not \"no extension\"", async () => {
    R.kv.clear();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '{"code":"woocommerce_rest_shop_order_invalid_id"}' })));
    await expect(run("get_shipment_tracking", { order_id: "999" })).rejects.toThrow("woocommerce_404");
    expect(R.kv.size).toBe(0);
  });

  it("★ risk groups: refund and coupons financial, address/customer sensitive, reads read", () => {
    const g = (t: string) => riskGroupFor(`woocommerce.${t}`);
    expect(g("create_refund")).toBe("financial");
    expect(g("disable_coupon")).toBe("financial");
    expect(g("update_shipping_address")).toBe("sensitive_data");
    expect(g("update_customer")).toBe("sensitive_data");
    expect(g("create_customer")).toBe("sensitive_data");
    for (const r of ["list_order_notes", "list_refunds", "get_product", "list_product_variations", "list_coupons", "get_coupon", "list_customer_orders", "get_shipment_tracking"]) {
      expect(g(r), r).toBe("read_only");
    }
  });
});
