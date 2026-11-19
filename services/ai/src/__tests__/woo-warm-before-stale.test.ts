/**
 * The warmer reloads a catalogue before it goes stale (2026-11-19). The catalogue is fresh for 10 minutes and a
 * pass runs every 8: a pass that found it fresh at 8 minutes left it, and the next one came at 16, so for 6 of
 * every 16 minutes a store's searches went to the store live. A pass now reloads a catalogue that would go stale
 * before the next pass.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, assertPublicUrl: vi.fn(async () => undefined) };
});

import Woo, { localProductList, warmWooCatalog } from "../services/connectors/woocommerce.adapter";
import { warmWooCachesOnce, WARM_EVERY_MS, type WarmDeps } from "../services/woo-cache-warmer.service";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const item = (id: number) => ({ id, name: `Item ${id}`, status: "publish", catalog_visibility: "visible", stock_status: "instock", price: "100", short_description: "", description: "", categories: [] });
// A catalogue of four pages of a hundred.
const CATALOG = Array.from({ length: 350 }, (_, i) => item(i + 1));
const PASS_MINUTES = WARM_EVERY_MS / 60_000;

let n = 0;
/** A store on a fake clock, the warmer's passes as the server runs them, and what each minute found. */
async function walk(minutes: number, warm?: WarmDeps["warm"]) {
  vi.useFakeTimers({ now: new Date("2026-11-19T10:00:00Z") });
  const base = `https://warm${++n}.example.com`;
  // Whole-catalogue page reads, by language.
  const pageReads: Record<string, number> = {};
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const u = new URL(url);
    let body: any = [];
    if (u.pathname.endsWith("/products")) {
      const page = Number(u.searchParams.get("page") ?? 1), per = Number(u.searchParams.get("per_page") ?? 10);
      const lang = u.searchParams.get("lang") ?? "";
      pageReads[lang] = (pageReads[lang] ?? 0) + 1;
      body = CATALOG.slice((page - 1) * per, page * per);
    }
    return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => body, text: async () => JSON.stringify(body) } as any;
  }));
  const pass = () => warmWooCachesOnce({
    tenants: async () => ["t1"],
    load: (async () => ({ credentials: { consumerKey: "ck", consumerSecret: "cs" }, config: { storeUrl: base } })) as any,
    ...(warm ? { warm } : {}),
  });
  const local = () => localProductList(`${base}/wp-json/wc/v3/products?per_page=20&search=item&lang=he`, Date.now()) !== null;
  // The boot pass, then one every WARM_EVERY_MS.
  expect((await pass())[0]).toMatchObject({ tenantId: "t1", ok: true });
  const cold = { ...pageReads };
  const live: number[] = [];
  // A pass starts its reload in the background; the store answers it inside a second.
  let since = 0;
  for (let m = 1; m <= minutes; m++) {
    await vi.advanceTimersByTimeAsync(60_000 - since);
    since = 0;
    // Read before this minute's pass: the catalogue at its oldest.
    if (!local()) live.push(m);
    if (m % PASS_MINUTES === 0) {
      await pass();
      // Also while the reload is on its way, and once it has landed.
      if (!local()) live.push(m + 0.1);
      await vi.advanceTimersByTimeAsync(1000);
      since = 1000;
      if (!local()) live.push(m + 0.5);
    }
  }
  await vi.advanceTimersByTimeAsync(1000);
  const reads = Object.fromEntries(Object.entries(pageReads).map(([k, v]) => [k, v - (cold[k] ?? 0)]));
  return { live, cold, reads };
}

describe("the warmer reloads a catalogue before it goes stale", () => {
  it("★ over 40 minutes a search is answered from the cached catalogue in every minute", async () => {
    const { live, cold } = await walk(40);
    expect(live).toEqual([]);
    // One load of a four page catalogue: pages 1 and 2, then 3, 4 and 5 together (5 comes back empty).
    expect(cold).toEqual({ "": 5, he: 5 });
  });

  it("the old pass (reload only once stale) left the store answering live for 6 of every 16 minutes", async () => {
    const { live } = await walk(40, (c, cfg) => warmWooCatalog(c, cfg));
    // Minute 16 and 32: read just before the pass that reloads it, and again while that reload is on its way.
    expect(live).toEqual([10, 11, 12, 13, 14, 15, 16, 16.1, 26, 27, 28, 29, 30, 31, 32, 32.1]);
  });

  it("the cost: one reload every pass, twice the old rate of whole-catalogue page reads", async () => {
    // 160 minutes: 20 passes.
    const now = await walk(160);
    const old = await walk(160, (c, cfg) => warmWooCatalog(c, cfg));
    expect(now.live).toEqual([]);
    // Per catalogue language: 20 reloads of 5 page reads against 10. Per hour: 37.5 against 18.75.
    expect(now.reads).toEqual({ "": 100, he: 100 });
    expect(old.reads).toEqual({ "": 50, he: 50 });
  });

  it("a customer's own search between two passes reloads nothing: the earlier reload is the pass's alone", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-19T10:00:00Z") });
    const base = `https://warm${++n}.example.com`;
    // Whole-catalogue page reads (a hundred a page, no search word) and every other product request.
    let pages = 0, other = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const u = new URL(url);
      let body: any = [];
      if (u.pathname.endsWith("/products")) {
        const page = Number(u.searchParams.get("page") ?? 1), per = Number(u.searchParams.get("per_page") ?? 10);
        if (per === 100 && !u.searchParams.get("search")) { pages++; body = CATALOG.slice((page - 1) * per, page * per); } else other++;
      }
      return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => body, text: async () => JSON.stringify(body) } as any;
    }));
    const conn = { credentials: { consumerKey: "ck", consumerSecret: "cs" }, config: { storeUrl: base } };
    await warmWooCachesOnce({ tenants: async () => ["t1"], load: (async () => conn) as any });
    expect(pages).toBe(10);
    // Seven minutes on: fresh for a customer (under 10), past the pass's own mark (2).
    await vi.advanceTimersByTimeAsync(7 * 60_000);
    const search = (query: string) => Woo.execute({ toolName: "list_products", args: { query }, ...conn } as any) as Promise<any[]>;
    // One the catalogue answers, and one no title has (it goes on to the catalogue's descriptions and names).
    expect((await search("item 7")).length).toBeGreaterThan(0);
    await search("gizmo unfindable");
    await vi.advanceTimersByTimeAsync(2000);
    expect(pages).toBe(10);
    expect(other).toBe(0);
  });
});
