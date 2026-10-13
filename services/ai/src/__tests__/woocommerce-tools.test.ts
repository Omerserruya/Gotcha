/**
 * WooCommerce tools against a stubbed store (no network). Write tools are
 * tested only like this; the real dev store gets read-only tools.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, assertPublicUrl: vi.fn(async () => undefined) };
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
