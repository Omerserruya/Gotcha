/**
 * Store requests and a Hebrew product search (prod 2026-11-17).
 *  - Replay 11: searching the words' other forms WITH the first round made a small
 *    shared-hosting store slower for every request. The forms run only after an
 *    empty first round, all at once.
 *  - At most WOO_STORE_CONCURRENCY (default 3) requests at once per store; the
 *    rest wait their turn.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, assertPublicUrl: vi.fn(async () => undefined) };
});

import Woo, { withStoreSlot } from "../services/connectors/woocommerce.adapter";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

let n = 0;
function store(answer: (search: string) => any[]) {
  const base = `https://tehila${++n}.example.com`;
  const started: Array<{ search: string; at: number }> = [];
  let active = 0, maxActive = 0;
  const t0 = Date.now();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const u = new URL(url);
    const search = u.searchParams.get("search") ?? "";
    started.push({ search, at: Date.now() - t0 });
    active++; maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 40));
    active--;
    let body: any = [];
    if (u.pathname.endsWith("/products/categories")) body = [];
    else if (u.pathname.endsWith("/products")) body = search ? answer(search) : [];
    return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => body, text: async () => JSON.stringify(body) } as any;
  }));
  const run = (args: Record<string, unknown>) =>
    Woo.execute({ toolName: "list_products", args, credentials: { consumerKey: "ck", consumerSecret: "cs" }, config: { storeUrl: base } } as any) as Promise<any[]>;
  return { run, started, maxActive: () => maxActive };
}

const item = (id: number, name: string) => ({ id, name, status: "publish", catalog_visibility: "visible", stock_status: "instock" });

describe("Hebrew product search", () => {
  it("★ a first round that finds it sends no form searches at all", async () => {
    const s = store((q) => (q === "מטפחת" ? [item(1, "מטפחת אנה")] : []));
    expect((await s.run({ query: "מטפחת" })).map((p) => p.id)).toEqual([1]);
    expect(s.started.some((x) => x.search === "מטפחות")).toBe(false);
  });
  it("★ an empty first round: the forms run after it, together, and the first that finds wins", async () => {
    const s = store((q) => (q === "מטפחות" ? [item(7, "מטפחות חגיגיות")] : []));
    expect((await s.run({ query: "מטפחת" })).map((p) => p.id)).toEqual([7]);
    const first = s.started.find((x) => x.search === "מטפחת")!;
    const forms = s.started.filter((x) => x.search && x.search !== "מטפחת");
    expect(forms.length).toBeGreaterThan(1);
    // After the first round's answer (40ms)...
    expect(Math.min(...forms.map((f) => f.at))).toBeGreaterThanOrEqual(first.at + 35);
    // ...and together (up to the store's cap of 3 at once), not one after another.
    const firstThree = forms.slice(0, 3).map((f) => f.at);
    expect(Math.max(...firstThree) - Math.min(...firstThree)).toBeLessThan(20);
  });
  it("★ never more than 3 requests at once to one store", async () => {
    const s = store(() => []);
    await s.run({ query: "מטפחת חגיגית כחולה" });
    expect(s.maxActive()).toBeLessThanOrEqual(3);
  });
});

describe("withStoreSlot", () => {
  it("★ caps concurrency per store origin, and lets another store run alongside", async () => {
    let a = 0, aMax = 0, b = 0, bMax = 0;
    const job = (which: "a" | "b") => async () => {
      if (which === "a") { a++; aMax = Math.max(aMax, a); } else { b++; bMax = Math.max(bMax, b); }
      await new Promise((r) => setTimeout(r, 20));
      if (which === "a") a--; else b--;
      return which;
    };
    const runs = [
      ...Array.from({ length: 7 }, () => withStoreSlot("https://a.example.com/x?1", job("a"))),
      ...Array.from({ length: 4 }, () => withStoreSlot("https://b.example.com/y", job("b"))),
    ];
    expect((await Promise.all(runs)).filter((x) => x === "a")).toHaveLength(7);
    expect(aMax).toBe(3);
    expect(bMax).toBe(3);
  });
  it("a failing request frees its slot", async () => {
    await expect(withStoreSlot("https://c.example.com", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await withStoreSlot("https://c.example.com", async () => "ok")).toBe("ok");
  });
});
