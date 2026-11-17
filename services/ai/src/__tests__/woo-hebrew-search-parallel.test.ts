/**
 * A Hebrew product search runs its rounds at once, not one after another (prod
 * timing 2026-11-17, Tehila warm: the title search, then the words' other forms,
 * then the category route, ~1.2s each in series, 2.5s). The other forms of the
 * words are searched alongside the first round and used only when it found nothing.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, assertPublicUrl: vi.fn(async () => undefined) };
});

import Woo from "../services/connectors/woocommerce.adapter";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

let n = 0;
function store(answer: (search: string) => any[]) {
  const base = `https://tehila${++n}.example.com`;
  const started: Array<{ search: string; at: number }> = [];
  const t0 = Date.now();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const u = new URL(url);
    const search = u.searchParams.get("search") ?? "";
    started.push({ search, at: Date.now() - t0 });
    // Every store request takes 60ms.
    await new Promise((r) => setTimeout(r, 60));
    let body: any = [];
    if (u.pathname.endsWith("/products/categories")) body = [];
    else if (u.pathname.endsWith("/products")) body = search ? answer(search) : [];
    return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => body, text: async () => JSON.stringify(body) } as any;
  }));
  const run = (args: Record<string, unknown>) =>
    Woo.execute({ toolName: "list_products", args, credentials: { consumerKey: "ck", consumerSecret: "cs" }, config: { storeUrl: base } } as any) as Promise<any[]>;
  return { run, started };
}

describe("Hebrew product search: one round, not three", () => {
  it("★ the words' other forms are searched in the same round as the first search, and win when it is empty", async () => {
    // Only the plural form is in a title.
    const s = store((q) => (q === "מטפחות" ? [{ id: 7, name: "מטפחות חגיגיות", status: "publish", catalog_visibility: "visible", stock_status: "instock" }] : []));
    const t = Date.now();
    const got = await s.run({ query: "מטפחת" });
    const ms = Date.now() - t;
    expect(got.map((p) => p.id)).toEqual([7]);
    const variant = s.started.find((x) => x.search === "מטפחות")!;
    const first = s.started.find((x) => x.search === "מטפחת")!;
    expect(variant).toBeTruthy();
    // Started together (before the first round's 60ms answer), not after it.
    expect(variant.at - first.at).toBeLessThan(40);
    // Categories, then one round: well under three rounds of 60ms after the categories.
    expect(ms).toBeLessThan(60 + 60 * 2 + 50);
  });
  it("a first round that finds it is used, the forms' answers ignored", async () => {
    const s = store((q) => (q === "מטפחת" ? [{ id: 1, name: "מטפחת אנה", status: "publish", catalog_visibility: "visible", stock_status: "instock" }] : q === "מטפחות" ? [{ id: 9, name: "מטפחות אחרות", status: "publish", catalog_visibility: "visible", stock_status: "instock" }] : []));
    expect((await s.run({ query: "מטפחת" })).map((p) => p.id)).toEqual([1]);
  });
});
