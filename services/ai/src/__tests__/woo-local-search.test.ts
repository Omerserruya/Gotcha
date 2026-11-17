/**
 * A small store's product search answered from its cached catalogue (prod replay
 * latency 2026-11-17: one list_products call made up to 12 live ?search= requests,
 * 10-14s, while the whole catalogue was cached and fresh).
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, assertPublicUrl: vi.fn(async () => undefined) };
});

import Woo, { localProductList, primeCatalogCache, warmWooCatalog, LIVE_SEARCH_CAP, MAX_LOCAL_CATALOGUE } from "../services/connectors/woocommerce.adapter";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); delete process.env.WOO_LOCAL_SEARCH; });

const item = (id: number, name: string, extra: Record<string, unknown> = {}) => ({ id, name, status: "publish", catalog_visibility: "visible", stock_status: "instock", price: "100", short_description: "", description: "", categories: [], ...extra });
const CATALOG = [
  item(1, "מטפחת אנה", { short_description: "<p>כותנה כחולה</p>" }),
  item(2, "מטפחת חגיגית זהב", { price: "180" }),
  item(3, "בנדנה מרובעת", { stock_status: "outofstock" }),
  item(4, "Oak Desk Pad", { description: "<b>Natural oak</b> desk pad" }),
];

let n = 0;
function store(catalog = CATALOG) {
  const base = `https://local${++n}.example.com`;
  const calls: string[] = [];
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    calls.push(decodeURIComponent(url));
    const u = new URL(url);
    let body: any = [];
    if (u.pathname.endsWith("/products/categories")) body = [];
    else if (u.pathname.endsWith("/products")) {
      const page = Number(u.searchParams.get("page") ?? 1), per = Number(u.searchParams.get("per_page") ?? 10);
      const q = (u.searchParams.get("search") ?? "").toLowerCase();
      body = (q ? catalog.filter((p) => p.name.toLowerCase().includes(q)) : catalog).slice((page - 1) * per, page * per);
    }
    return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => body, text: async () => JSON.stringify(body) } as any;
  }));
  const run = (args: Record<string, unknown>) => Woo.execute({ toolName: "list_products", args, credentials: { consumerKey: "ck", consumerSecret: "cs" }, config: { storeUrl: base } } as any) as Promise<any[]>;
  const searches = () => calls.filter((u) => /\/products\?/.test(u) && !/[?&]page=\d/.test(u));
  const warm = () => warmWooCatalog({ consumerKey: "ck", consumerSecret: "cs" }, { storeUrl: base });
  return { base, run, calls, searches, warm };
}

describe("local product search on a small store", () => {
  it("★ warm: the search runs over the cached catalogue, with no ?search= request to the store", async () => {
    const s = store();
    await s.warm(); // as the server's warmer does, in every language a turn reads
    const before = s.searches().length;
    const found = await s.run({ query: "מטפחת" });
    expect(found.map((p) => p.id).sort()).toEqual([1, 2]);
    expect(s.searches().length).toBe(before);
  });

  it("★ WOO_LOCAL_SEARCH=off asks the store, as before", async () => {
    const s = store();
    await s.warm();
    process.env.WOO_LOCAL_SEARCH = "off";
    const before = s.searches().length;
    await s.run({ query: "מטפחת" });
    expect(s.searches().length).toBeGreaterThan(before);
  });

  it("★ the REST filters, locally: every word in the title, excerpt or content; stock; price; include; paging", () => {
    const base = "https://unit.example.com/wp-json/wc/v3";
    // Not cached: no local answer.
    expect(localProductList(`${base}/products?search=x`)).toBeNull();
    primeCatalogCache(base, "", CATALOG);
    const ids = (u: string) => localProductList(`${base}/products?${u}`)?.map((p) => p.id) ?? null;
    expect(ids("search=מטפחת&status=publish")).toEqual([1, 2]);
    // Every word, in any of the three texts (the excerpt's markup ignored).
    expect(ids("search=מטפחת כחולה")).toEqual([1]);
    expect(ids("search=natural oak")).toEqual([4]);
    expect(ids("search=מטפחת ירוקה")).toEqual([]);
    expect(ids("stock_status=instock&per_page=100")).toEqual([1, 2, 4]);
    expect(ids("min_price=150")).toEqual([2]);
    expect(ids("max_price=150")).toEqual([1, 3, 4]);
    expect(ids("include=3,4")).toEqual([3, 4]);
    expect(ids("exclude=1")).toEqual([2, 3, 4]);
    expect(ids("per_page=2&page=2")).toEqual([3, 4]);
    // A category read, or a parameter it does not emulate: the store's.
    expect(ids("category=12")).toBeNull();
    expect(ids("orderby=date")).toBeNull();
    // Per language.
    expect(ids("lang=he")).toBeNull();
    // Stale (older than the 10 minutes) or too big: the store's.
    primeCatalogCache(base, "", CATALOG, Date.now() - 11 * 60_000);
    expect(ids("search=מטפחת")).toBeNull();
    primeCatalogCache(base, "", Array.from({ length: MAX_LOCAL_CATALOGUE + 1 }, (_, i) => item(i + 10, `x${i}`)));
    expect(ids("search=x1")).toBeNull();
  });

  it("★ a cold store: at most LIVE_SEARCH_CAP live requests per call", async () => {
    // A catalogue that never loads (empty pages are fine; a failing read is not cached).
    const calls: string[] = [];
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      const u = new URL(url);
      if (/[?&]page=\d/.test(u.search)) return { ok: false, status: 500, headers: new Headers(), json: async () => ({}), text: async () => "down" } as any;
      return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => [], text: async () => "[]" } as any;
    }));
    const base = `https://cold${++n}.example.com`;
    await Woo.execute({ toolName: "list_products", args: { query: "מטפחת חגיגית כחולה", in_stock: true }, credentials: { consumerKey: "ck", consumerSecret: "cs" }, config: { storeUrl: base } } as any).catch(() => []);
    const live = calls.filter((u) => /\/products\?/.test(u) && !/[?&]page=\d/.test(u));
    expect(live.length).toBeLessThanOrEqual(LIVE_SEARCH_CAP);
  });

  it("★ the catalogue is read whole up to 500 products (pages 3 to 5 only when needed), and not at all above", async () => {
    const mid = store(Array.from({ length: 250 }, (_, i) => item(i + 1, `פריט ${i}`)));
    await mid.warm();
    expect(localProductList(`${mid.base}/wp-json/wc/v3/products?search=${encodeURIComponent("פריט 249")}`)?.map((p) => p.id)).toEqual([250]);
    const big = store(Array.from({ length: 600 }, (_, i) => item(i + 1, `פריט ${i}`)));
    await big.warm();
    expect(localProductList(`${big.base}/wp-json/wc/v3/products?search=x`)).toBeNull();
    expect(big.calls.some((u) => /[?&]page=6(?:&|$)/.test(u))).toBe(false);
  });
});
