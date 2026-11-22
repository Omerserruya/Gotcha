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

import Woo, { cacheCounts, localProductList, warmWooCatalog, CATALOG_OVER_LIMIT_MS } from "../services/connectors/woocommerce.adapter";
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
  for (const k of Object.keys(cacheCounts)) delete (cacheCounts as any)[k];
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
  return { live, cold, reads, counts: { ...cacheCounts.catalog } };
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

  it("the counters: a pass that reloads a catalogue still fresh for readers is a warmReload, never a stale serve", async () => {
    // 40 minutes, two catalogue languages: the boot pass loads both (2 misses), then 5 passes.
    const now = await walk(40);
    expect(now.counts).toEqual({ hit: 0, stale: 0, miss: 2, warmReload: 10 });
    // The old pass: fresh at minutes 8, 24 and 40 (hits), past its window at 16 and 32 (stale, in its real meaning).
    const old = await walk(40, (c, cfg) => warmWooCatalog(c, cfg));
    expect(old.counts).toEqual({ hit: 6, stale: 4, miss: 2, warmReload: 0 });
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

/**
 * A store over the local limit (2026-11-19). Five full pages mean nothing of the catalogue is kept, and every pass
 * read those five pages per language again: 10 full pages every 8 minutes for no cached answer. The verdict now
 * stands for CATALOG_OVER_LIMIT_MS.
 */
describe("a store over the local limit is not read again every pass", () => {
  /**
   * A store whose size the test sets, on a fake clock: its whole-catalogue page reads, and its own queries (it
   * finds "item", and nothing for any other word).
   */
  function sizedStore(size: number) {
    vi.useFakeTimers({ now: new Date("2026-11-19T10:00:00Z") });
    const base = `https://warm${++n}.example.com`;
    // byLang: a size for one catalogue language alone ("" is the list with no language asked).
    const s = { size, byLang: {} as Record<string, number>, pages: 0, pagesOf: {} as Record<string, number>, own: 0, hold: null as Promise<void> | null };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const u = new URL(url);
      let body: any = [];
      if (u.pathname.endsWith("/products")) {
        const page = Number(u.searchParams.get("page") ?? 1), per = Number(u.searchParams.get("per_page") ?? 10);
        if (per === 100 && !u.searchParams.get("search")) {
          const lang = u.searchParams.get("lang") ?? "";
          s.pages++;
          s.pagesOf[lang] = (s.pagesOf[lang] ?? 0) + 1;
          if (s.hold) await s.hold;
          // One product is told apart only by its description: only the whole catalogue finds it.
          body = Array.from({ length: s.byLang[lang] ?? s.size }, (_, i) => (i === 41 ? { ...item(42), description: "a quiet zephyr thing" } : item(i + 1))).slice((page - 1) * per, page * per);
        } else { s.own++; body = /item/i.test(u.searchParams.get("search") ?? "") ? [item(7)] : []; }
      }
      return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => body, text: async () => JSON.stringify(body) } as any;
    }));
    const conn = { credentials: { consumerKey: "ck", consumerSecret: "cs" }, config: { storeUrl: base } };
    // A pass, and the second its background reads take to land.
    const pass = async () => { await warmWooCachesOnce({ tenants: async () => ["t1"], load: (async () => conn) as any }); await vi.advanceTimersByTimeAsync(1000); };
    const search = (query: string) => Woo.execute({ toolName: "list_products", args: { query }, ...conn } as any) as Promise<any[]>;
    const local = () => localProductList(`${base}/wp-json/wc/v3/products?per_page=20&search=item&lang=he`, Date.now()) !== null;
    // To the next pass (a pass took one second of the eight minutes).
    const toNextPass = () => vi.advanceTimersByTimeAsync(WARM_EVERY_MS - 1000);
    return { s, pass, search, local, toNextPass };
  }
  // A search the store's own query answers, and one no title has: it goes on to the whole catalogue.
  const FOUND = "item 7", UNFOUND = "gizmo unfindable";
  const PASSES_IN_WINDOW = CATALOG_OVER_LIMIT_MS / WARM_EVERY_MS;

  it("the window is a whole number of passes (the counts below lean on it)", () => {
    expect(CATALOG_OVER_LIMIT_MS).toBe(6 * 60 * 60_000);
    expect(PASSES_IN_WINDOW).toBe(45);
  });

  it("★ read once: inside the window neither a pass nor a search reads its pages again", async () => {
    const { s, pass, search, local, toNextPass } = sizedStore(620);
    await pass();
    // Five full pages in each of the two languages, and nothing kept.
    expect(s.pages).toBe(10);
    expect(local()).toBe(false);
    // Every pass up to the last one inside the window (minute 352), with a search between some of them.
    for (let p = 1; p < PASSES_IN_WINDOW; p++) {
      await toNextPass();
      if (p % 10 === 3) {
        const own = s.own;
        // The store's own query answers it, as before.
        expect((await search(FOUND)).length).toBeGreaterThan(0);
        expect(s.own).toBeGreaterThan(own);
        await search(UNFOUND);
        await vi.advanceTimersByTimeAsync(0);
      }
      await pass();
      expect(s.pages).toBe(10);
    }
    // The window is over: one more read of the five pages per language, and a new window.
    await toNextPass();
    await pass();
    expect(s.pages).toBe(20);
    await toNextPass();
    await pass();
    expect(s.pages).toBe(20);
  });

  it("a search alone, with no pass near it, reads no page inside the window", async () => {
    const { s, pass, search } = sizedStore(620);
    await pass();
    expect(s.pages).toBe(10);
    // Half an hour on: the kept verdict is long past the ten minutes a catalogue is fresh for.
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    const own = s.own;
    expect(await search(UNFOUND)).toEqual([]);
    expect((await search(FOUND)).length).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.own).toBeGreaterThan(own);
    expect(s.pages).toBe(10);
    // The last minute of the window.
    await vi.advanceTimersByTimeAsync(CATALOG_OVER_LIMIT_MS - 30 * 60_000 - 2000 - 1000 - 60_000);
    await search(UNFOUND);
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.pages).toBe(10);
  });

  it("a store that shrank under the limit is held after the window, and from then on is a store like any other", async () => {
    const { s, pass, search, local, toNextPass } = sizedStore(620);
    await pass();
    expect(s.pages).toBe(10);
    s.size = 350;
    await toNextPass();
    await pass();
    // Inside the window: not read, so not known yet.
    expect(s.pages).toBe(10);
    expect(local()).toBe(false);
    // To the first pass after the window.
    await vi.advanceTimersByTimeAsync(CATALOG_OVER_LIMIT_MS - 2 * WARM_EVERY_MS);
    await toNextPass();
    await pass();
    // Four pages of products and the empty fifth, per language; the catalogue is held.
    expect(s.pages).toBe(20);
    expect(local()).toBe(true);
    const own = s.own;
    expect((await search(FOUND)).length).toBeGreaterThan(0);
    // And a search reads the held catalogue itself: a word only a description has.
    expect((await search("zephyr")).map((p: any) => p.id)).toEqual([42]);
    expect(s.own).toBe(own);
    // And reloaded by every pass, as a store under the limit is.
    await toNextPass();
    await pass();
    expect(s.pages).toBe(30);
    await toNextPass();
    await pass();
    expect(s.pages).toBe(40);
  });

  it("a store that grew over the limit is read once more and then left alone", async () => {
    const { s, pass, local, toNextPass } = sizedStore(350);
    await pass();
    expect(s.pages).toBe(10);
    expect(local()).toBe(true);
    await toNextPass();
    await pass();
    expect(s.pages).toBe(20);
    s.size = 620;
    // The pass that finds it over the limit.
    await toNextPass();
    await pass();
    expect(s.pages).toBe(30);
    expect(local()).toBe(false);
    for (let p = 0; p < 5; p++) { await toNextPass(); await pass(); }
    expect(s.pages).toBe(30);
  });

  it("the verdict is one catalogue language's: the other, under the limit, is held and reloaded as before", async () => {
    const { s, pass, local, toNextPass } = sizedStore(620);
    s.byLang.he = 350;
    await pass();
    expect(s.pagesOf).toEqual({ "": 5, he: 5 });
    expect(local()).toBe(true);
    for (let p = 0; p < 4; p++) { await toNextPass(); await pass(); }
    // The Hebrew catalogue: every pass, as at any store under the limit. The other list: once.
    expect(s.pagesOf).toEqual({ "": 5, he: 25 });
    expect(local()).toBe(true);
  });

  it("after the window a search never waits for the pages: the store's own query answers while they load", async () => {
    const { s, pass, search } = sizedStore(620);
    await pass();
    expect(s.pages).toBe(10);
    await vi.advanceTimersByTimeAsync(CATALOG_OVER_LIMIT_MS);
    // The store answers its catalogue pages only when the test lets it.
    let release!: () => void;
    s.hold = new Promise<void>((r) => { release = r; });
    const own = s.own;
    // Answered (the store's own query found nothing for it) while no catalogue page has come back.
    expect(await search(UNFOUND)).toEqual([]);
    expect(s.own).toBeGreaterThan(own);
    // The read began (the first two pages of one language are out) and has not landed.
    expect(s.pages).toBe(12);
    release();
    s.hold = null;
    await vi.advanceTimersByTimeAsync(1000);
    // Five full pages of that one language, and still over the limit: a new window.
    expect(s.pages).toBe(15);
    await search(UNFOUND);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.pages).toBe(15);
  }, 4000);
});
