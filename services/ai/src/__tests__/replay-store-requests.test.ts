/**
 * The replay as the server (timeouts thread, 2026-11-19): the store caches are warmed again on the server's
 * timer while the turns run, and each product search call is in the report with how its store requests were
 * answered (from the cached catalogue, by the store, or not asked).
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, assertPublicUrl: vi.fn(async () => undefined) };
});
vi.mock("../services/reply-engine/engine", () => ({ runReplyEngineTurn: vi.fn() }));

import Woo, { primeCatalogCache, searchRequestCounts } from "../services/connectors/woocommerce.adapter";
import { getAdapter } from "../services/connectors/integration-framework";
import { WARM_EVERY_MS } from "../services/woo-cache-warmer.service";
import { startReplayWarmer, watchStoreSearches, storeRequestsLine, searchLine } from "../scripts/replay-v2";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("the replay warms the store caches again on the server's timer", () => {
  it("★ a pass at each of the server's periods, none before, none after stop()", async () => {
    vi.useFakeTimers();
    const pass = vi.fn(async () => undefined);
    const warmer = startReplayWarmer(pass);
    await vi.advanceTimersByTimeAsync(WARM_EVERY_MS - 1);
    expect(pass).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(pass).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(WARM_EVERY_MS);
    expect(pass).toHaveBeenCalledTimes(2);
    expect(warmer.passes()).toBe(2);
    warmer.stop();
    await vi.advanceTimersByTimeAsync(3 * WARM_EVERY_MS);
    expect(pass).toHaveBeenCalledTimes(2);
    expect(warmer.passes()).toBe(2);
  });

  it("★ the server's period is 8 minutes, and a pass that fails does not end the timer", async () => {
    expect(WARM_EVERY_MS).toBe(8 * 60_000);
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => { unhandled.push(e); };
    process.on("unhandledRejection", onUnhandled);
    try {
      vi.useFakeTimers();
      // A plain function: a mock keeps its returned promise, which would hide a rejection nobody handles.
      let ran = 0;
      const warmer = startReplayWarmer(async () => { ran++; throw new Error("store down"); });
      await vi.advanceTimersByTimeAsync(2 * WARM_EVERY_MS);
      expect(ran).toBe(2);
      warmer.stop();
      vi.useRealTimers();
      await tick();
      expect(unhandled).toEqual([]);
    } finally { process.off("unhandledRejection", onUnhandled); }
  });
});

const item = (id: number, name: string, extra: Record<string, unknown> = {}) => ({ id, name, status: "publish", catalog_visibility: "visible", stock_status: "instock", price: "100", short_description: "", description: "", categories: [], ...extra });
const CATALOG = [item(1, "מטפחת אנה"), item(2, "מטפחת חגיגית זהב", { price: "180" }), item(3, "בנדנה מרובעת", { stock_status: "outofstock" })];
const MIN = 60_000;

let n = 0;
/** A store behind a stubbed fetch. `search` decides what a ?search= request does (default: the store answers). */
function store(opts: { cachedAgoMs?: number; search?: () => Promise<void> } = {}) {
  const base = `https://requests${++n}.example.com`;
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: any[]) => { lines.push(String(a[0])); });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const u = new URL(url);
    let body: any = [];
    if (u.host === new URL(base).host && u.pathname.endsWith("/products")) {
      if (u.searchParams.get("search")) await opts.search?.();
      const q = (u.searchParams.get("search") ?? "").toLowerCase();
      body = Number(u.searchParams.get("page") ?? 1) === 1 ? (q ? CATALOG.filter((p) => p.name.toLowerCase().includes(q)) : CATALOG) : [];
    }
    return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => body, text: async () => JSON.stringify(body) } as any;
  }));
  for (const lang of ["", "he", "en"]) primeCatalogCache(`${base}/wp-json/wc/v3`, lang, CATALOG, Date.now() - (opts.cachedAgoMs ?? 0));
  const run = (toolName: string, args: Record<string, unknown>) => Woo.execute({ toolName, args, credentials: { consumerKey: "ck", consumerSecret: "cs" }, config: { storeUrl: base } } as any) as Promise<any>;
  const countLines = () => lines.filter((l) => l.startsWith("[woo-search] requests"));
  return { base, run, countLines };
}
const tick = () => new Promise((r) => setTimeout(r, 20));

describe("each product search call of a turn, with how the store's connector answered its requests", () => {
  it("★ a catalogue read under 10 minutes ago: the connector's own line for the call, all local", async () => {
    const s = store({ cachedAgoMs: 2 * MIN });
    const watch = watchStoreSearches(Woo);
    try {
      const found = await s.run("list_products", { query: "מטפחת" });
      expect(found.map((p: any) => p.id).sort()).toEqual([1, 2]);
      const calls = watch.take();
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ args: { query: "מטפחת" }, ended: "ok", shared: false });
      expect(calls[0].counted!.local).toBeGreaterThan(0);
      expect(calls[0].counted).toMatchObject({ live: 0, capped: 0 });
      // The numbers are the connector's own line, still printed as before.
      expect(s.countLines()).toEqual([`[woo-search] requests local=${calls[0].counted!.local} live=0 capped=0`]);
      expect(storeRequestsLine(calls)).toBe(`{"query":"מטפחת"} local=${calls[0].counted!.local} live=0 capped=0`);
      // One turn's calls: taken once.
      expect(watch.take()).toEqual([]);
    } finally { watch.stop(); }
  });

  it("★ the same search on a catalogue read 11 minutes ago goes to the store", async () => {
    const s = store({ cachedAgoMs: 11 * MIN });
    const watch = watchStoreSearches(Woo);
    try {
      await s.run("list_products", { query: "מטפחת" });
      const [call] = watch.take();
      expect(call.counted!.local).toBe(0);
      expect(call.counted!.live).toBeGreaterThan(0);
      expect(storeRequestsLine([call])).toBe(`{"query":"מטפחת"} local=0 live=${call.counted!.live} capped=${call.counted!.capped}`);
    } finally { watch.stop(); }
  });

  it("★ two searches at once: each call has its own line, never the other's", async () => {
    const fresh = store({ cachedAgoMs: 1 * MIN });
    const stale = store({ cachedAgoMs: 11 * MIN });
    // One fetch stub and one console spy serve both stores: the later ones.
    for (const lang of ["", "he", "en"]) primeCatalogCache(`${fresh.base}/wp-json/wc/v3`, lang, CATALOG, Date.now() - MIN);
    const watch = watchStoreSearches(Woo);
    try {
      await Promise.all([fresh.run("list_products", { query: "מטפחת אנה" }), stale.run("list_products", { query: "בנדנה" })]);
      const calls = watch.take();
      expect(calls.map((c) => c.args.query)).toEqual(["מטפחת אנה", "בנדנה"]);
      expect(calls[0].counted!.live).toBe(0);
      expect(calls[0].counted!.local).toBeGreaterThan(0);
      expect(calls[1].counted!.local).toBe(0);
      expect(calls[1].counted!.live).toBeGreaterThan(0);
      expect(calls.map((c) => c.shared)).toEqual([true, true]);
    } finally { watch.stop(); }
  });

  it("★ a search that fails prints no line of its own: it is in the report as failed, with the requests made while it ran", async () => {
    let down = true;
    const s = store({ cachedAgoMs: 11 * MIN, search: async () => { if (down) throw new Error("woocommerce_timeout"); } });
    const watch = watchStoreSearches(Woo);
    try {
      const before = { ...searchRequestCounts };
      await expect(s.run("list_products", { query: "מטפחת" })).rejects.toThrow();
      const made = searchRequestCounts.live - before.live;
      expect(s.countLines()).toEqual([]);
      // A later search of the turn: its requests are not the failed call's.
      down = false;
      await s.run("list_products", { query: "בנדנה" });
      const [call, later] = watch.take();
      expect(later.counted!.live).toBeGreaterThan(0);
      expect(call.counted).toBeUndefined();
      expect(call.ended).toBe("failed");
      expect(call.shared).toBe(false);
      expect(made).toBeGreaterThan(0);
      expect(call.during.live).toBe(made);
      expect(storeRequestsLine([call])).toBe(`{"query":"מטפחת"} failed, no count line; store requests while it ran: local=${call.during.local} live=${call.during.live} capped=${call.during.capped}`);
    } finally { watch.stop(); }
  });

  it("★ a search still running when the turn ends is in that turn's report, and not in the next turn's", async () => {
    let release = () => undefined as void;
    const held = new Promise<void>((r) => { release = r; });
    const s = store({ cachedAgoMs: 11 * MIN, search: () => held });
    const watch = watchStoreSearches(Woo);
    try {
      const running = s.run("list_products", { query: "מטפחת" });
      await tick();
      const [call] = watch.take();
      expect(call.ended).toBeUndefined();
      expect(call.counted).toBeUndefined();
      expect(call.during.live).toBeGreaterThan(0);
      expect(storeRequestsLine([call])).toBe(`{"query":"מטפחת"} still running when the turn ended; store requests so far: local=0 live=${call.during.live} capped=${call.during.capped}`);
      release();
      await running;
      expect(watch.take()).toEqual([]);
    } finally { release(); watch.stop(); }
  });

  it("★ the connector's own retries are requests of the same call, and other tools are not search calls", async () => {
    const s = store({ cachedAgoMs: 1 * MIN });
    const inner = vi.spyOn(Woo, "execute");
    const watch = watchStoreSearches(Woo);
    try {
      // Nothing in stock by this name: the connector asks itself again without the stock filter.
      await s.run("list_products", { query: "בנדנה", in_stock: true });
      expect(inner.mock.calls.length).toBeGreaterThan(1);
      expect(watch.take()).toHaveLength(1);
      await s.run("get_product", { product_id: 1 }).catch(() => undefined);
      expect(watch.take()).toEqual([]);
    } finally { watch.stop(); }
  });

  it("★ stop() puts the connector and the console back; no connector, nothing watched", async () => {
    const execute = Woo.execute, log = console.log;
    const watch = watchStoreSearches(Woo);
    expect(Woo.execute).not.toBe(execute);
    expect(console.log).not.toBe(log);
    watch.stop();
    expect(Woo.execute).toBe(execute);
    expect(console.log).toBe(log);
    const none = watchStoreSearches(null);
    expect(none.take()).toEqual([]);
    none.stop();
    expect(console.log).toBe(log);
  });

  it("★ the connector the replay watches is the one the tools run", () => {
    expect(getAdapter("woocommerce")).toBe(Woo);
  });

  it("★ the process's counts are the connector's exported ones", async () => {
    const s = store({ cachedAgoMs: 11 * MIN });
    const before = { ...searchRequestCounts };
    const watch = watchStoreSearches(Woo);
    try {
      await s.run("list_products", { query: "מטפחת" });
      const [call] = watch.take();
      expect(call.during).toEqual({ local: searchRequestCounts.local - before.local, live: searchRequestCounts.live - before.live, capped: searchRequestCounts.capped - before.capped });
      expect(call.during).toEqual(call.counted);
    } finally { watch.stop(); }
  });
});

describe("the store requests in the report's search line", () => {
  const counts = (local: number, live: number, capped: number) => ({ local, live, capped });
  const call = (over: Record<string, unknown>) => ({ args: { query: "משטח" }, during: counts(0, 0, 0), shared: false, ...over }) as any;

  it("★ each state of a call, in the order the calls began", () => {
    expect(storeRequestsLine([
      call({ counted: counts(3, 0, 0), ended: "ok" }),
      call({ args: { query: "מתקן", in_stock: true }, counted: counts(0, 4, 2), ended: "ok" }),
    ])).toBe('{"query":"משטח"} local=3 live=0 capped=0; {"query":"מתקן","in_stock":true} local=0 live=4 capped=2');
    expect(storeRequestsLine([call({ ended: "failed", during: counts(0, 2, 0) })])).toBe('{"query":"משטח"} failed, no count line; store requests while it ran: local=0 live=2 capped=0');
    expect(storeRequestsLine([call({ ended: "failed", during: counts(1, 5, 0), shared: true })])).toBe('{"query":"משטח"} failed, no count line; store requests while it ran: local=1 live=5 capped=0 (with another search running)');
    expect(storeRequestsLine([call({ ended: "ok" })])).toBe('{"query":"משטח"} no count line; store requests while it ran: local=0 live=0 capped=0');
    expect(storeRequestsLine([call({ during: counts(0, 1, 0) })])).toBe('{"query":"משטח"} still running when the turn ended; store requests so far: local=0 live=1 capped=0');
    // A call with its own line needs no note: the line is of that call alone.
    expect(storeRequestsLine([call({ counted: counts(2, 1, 0), ended: "ok", shared: true })])).toBe('{"query":"משטח"} local=2 live=1 capped=0');
  });

  it("★ the connector's own marks and empty args are not printed; long args are cut", () => {
    expect(storeRequestsLine([call({ args: { query: "משטח", _semantic: true, category: null, lang: undefined, per_page: 5 }, counted: counts(1, 0, 0) })])).toBe('{"query":"משטח","per_page":5} local=1 live=0 capped=0');
    const long = storeRequestsLine([call({ args: { query: "a".repeat(300) }, counted: counts(1, 0, 0) })]);
    expect(long).toBe(`${JSON.stringify({ query: "a".repeat(300) }).slice(0, 120)} local=1 live=0 capped=0`);
  });

  it("★ after what was sent and what the model asked; alone when the turn has neither; no segment without a call", () => {
    const trace = { searchArgs: [{ tool: "woocommerce.list_products", q: "משטח" }], tools: [{ tool: "woocommerce.list_products", args: { query: "משטח" }, outcome: "ok", resultCount: 2, content: 'PRODUCT_1: "משטח א" | 100' }] };
    const base = searchLine(trace);
    expect(base).toBe('sent: list_products q="משטח" | model args: list_products {"query":"משטח"} -> ok (2) ["משטח א"]');
    expect(searchLine(trace, [])).toBe(base);
    expect(searchLine(trace, [call({ counted: counts(3, 0, 0) })])).toBe(`${base} | store requests: {"query":"משטח"} local=3 live=0 capped=0`);
    expect(searchLine(null, [call({ ended: "failed", during: counts(0, 4, 1) })])).toBe('store requests: {"query":"משטח"} failed, no count line; store requests while it ran: local=0 live=4 capped=1');
    expect(searchLine(null)).toBe("none");
    expect(searchLine({}, [])).toBe("none");
  });
});
