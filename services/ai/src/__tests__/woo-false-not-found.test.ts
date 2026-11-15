/**
 * Eval A05 on dev (2026-11-15, gpt-6-luna): "יש גרביים?" searched
 * { query: "גרביים", audience: "women", in_stock: false, price_max: 0 } on the
 * demo store, whose title is "Crew Socks 3-Pack": nothing, and the bot said
 * "לא מצאנו גרביים בקטלוג". The same args with "socks" found it. The Hebrew
 * word on an English-title store was the miss; the filters can miss the same
 * way. Each now searches again before the bot hears "nothing".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const H = vi.hoisted(() => ({ translate: vi.fn(async (_t: string, _q: string): Promise<string | null> => "socks") }));
vi.mock("@chatcenter/shared", async (orig) => ({
  ...(await orig() as any),
  assertPublicUrl: vi.fn(async () => undefined),
  getRedis: () => ({ get: async () => null, set: async () => "OK", del: async () => 0 }),
}));
vi.mock("../services/query-translation.service", async (orig) => ({ ...(await orig() as any), productQueryInEnglish: H.translate }));

import Woo from "../services/connectors/woocommerce.adapter";

// The demo store as on dev: English titles and categories, the socks in no Men / Women category, sold out.
const CATS = [
  { id: 10, name: "Clothing", parent: 0, count: 20 }, { id: 11, name: "Accessories", parent: 0, count: 4 },
  { id: 57, name: "Women", parent: 0, count: 12 }, { id: 58, name: "Men", parent: 0, count: 10 },
];
const P = (id: number, name: string, cats: number[], stock: string, price: string) =>
  ({ id, name, status: "publish", catalog_visibility: "visible", categories: cats.map((id) => ({ id })), stock_status: stock, price, description: "" });
const PRODUCTS = [P(440, "Crew Socks 3-Pack", [11], "outofstock", "79"), P(300, "Linen Shirt", [10, 58], "instock", "199")];

let calls: URL[] = [];
let store = 0;
const cfg = () => ({ credentials: { consumerKey: "ck", consumerSecret: "cs" }, config: { storeUrl: `https://demo${++store}.example.com` } });
const ctx = { tenantId: "t1", tenantIntegrationId: "ti1" };
const search = (args: any, withCtx = true) => Woo.execute({ toolName: "list_products", args, ...cfg(), ...(withCtx ? { ctx } : {}) } as any) as Promise<any[]>;

beforeEach(() => {
  calls = [];
  H.translate.mockClear();
  H.translate.mockImplementation(async () => "socks");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const u = new URL(url); calls.push(u);
    let body: any = [];
    if (u.pathname.endsWith("/products/categories")) body = CATS;
    else if (u.pathname.endsWith("/products")) {
      const q = (u.searchParams.get("search") ?? "").toLowerCase();
      body = PRODUCTS.filter((p) => !q || p.name.toLowerCase().includes(q))
        .filter((p) => u.searchParams.get("stock_status") !== "instock" || p.stock_status === "instock")
        .filter((p) => !u.searchParams.has("max_price") || Number(p.price) <= Number(u.searchParams.get("max_price")))
        .filter((p) => !u.searchParams.get("category") || p.categories.some((c) => String(c.id) === u.searchParams.get("category")));
    }
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("A05: a Hebrew word on an English-title store", () => {
  it("run 1's exact args find the socks, through one translation", async () => {
    const got = await search({ query: "גרביים", audience: "women", in_stock: false, per_page: 10, price_max: 0, price_min: 0 });
    expect(got.map((p) => p.name)).toEqual(["Crew Socks 3-Pack"]);
    expect(H.translate).toHaveBeenCalledTimes(1);
    expect(H.translate).toHaveBeenCalledWith("t1", "גרביים");
    expect(got[0].stock_status).toBe("outofstock");
  });
  it("no translation (refused, failed, timed out): the empty result stands", async () => {
    H.translate.mockImplementation(async () => null);
    expect(await search({ query: "גרביים" })).toEqual([]);
  });
  it("a translation that finds nothing too: empty, and translated once only", async () => {
    H.translate.mockImplementation(async () => "umbrella");
    expect(await search({ query: "מטריה" })).toEqual([]);
    expect(H.translate).toHaveBeenCalledTimes(1);
  });
  it("a translation that is still Hebrew is searched once, never translated again", async () => {
    H.translate.mockImplementation(async () => "גרב");
    expect(await search({ query: "גרביים" })).toEqual([]);
    expect(H.translate).toHaveBeenCalledTimes(1);
  });
  it("no tenant (a caller without ctx): no translation", async () => {
    expect(await search({ query: "גרביים" }, false)).toEqual([]);
    expect(H.translate).not.toHaveBeenCalled();
  });
  it("a Hebrew catalogue is never translated", async () => {
    const he = [{ id: 1, name: "אביזרים", parent: 0, count: 3 }, { id: 2, name: "ביגוד", parent: 0, count: 9 }];
    const f = (globalThis.fetch as any);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (new URL(url).pathname.endsWith("/products/categories")
      ? { ok: true, status: 200, headers: { get: () => null }, json: async () => he, text: async () => JSON.stringify(he) }
      : f(url))));
    expect(await search({ query: "גרביים" })).toEqual([]);
    expect(H.translate).not.toHaveBeenCalled();
  });
  it("a Latin query is searched as it is, no translation", async () => {
    expect((await search({ query: "socks" })).map((p) => p.name)).toEqual(["Crew Socks 3-Pack"]);
    expect(H.translate).not.toHaveBeenCalled();
  });
});

describe("a filter the model added never makes a false 'not found'", () => {
  it("price_max 0 is no budget", async () => {
    expect((await search({ query: "socks", price_max: 0 })).map((p) => p.name)).toEqual(["Crew Socks 3-Pack"]);
    expect(calls.some((u) => u.searchParams.has("max_price"))).toBe(false);
  });
  it("a real budget still filters", async () => {
    expect(await search({ query: "socks", price_max: 50 })).toEqual([]);
    expect(calls.some((u) => u.searchParams.get("max_price") === "50")).toBe(true);
  });
  it("in_stock: true with nothing in stock: the sold-out product, marked sold out", async () => {
    const got = await search({ query: "socks", in_stock: true });
    expect(got.map((p) => [p.name, p.stock_status])).toEqual([["Crew Socks 3-Pack", "outofstock"]]);
    expect(calls.some((u) => u.searchParams.get("stock_status") === "instock")).toBe(true);
  });
  it("in_stock: true with something in stock: only that", async () => {
    expect((await search({ query: "shirt", in_stock: true })).map((p) => p.name)).toEqual(["Linen Shirt"]);
  });
  it("an audience with none in its category: what the search found, each marked outside_audience", async () => {
    const got = await search({ query: "socks", audience: "women" });
    expect(got.map((p) => [p.name, p.outside_audience])).toEqual([["Crew Socks 3-Pack", "women"]]);
  });
  it("an audience with products in its category: only those, unmarked", async () => {
    const got = await search({ query: "shirt", audience: "men" });
    expect(got.map((p) => [p.name, p.outside_audience])).toEqual([["Linen Shirt", undefined]]);
    expect(await search({ query: "shirt", audience: "women" }).then((l) => l.map((p) => p.outside_audience))).toEqual(["women"]);
  });
  it("a search that finds nothing at all stays empty", async () => {
    expect(await search({ query: "umbrella", audience: "women", in_stock: true })).toEqual([]);
  });
});
