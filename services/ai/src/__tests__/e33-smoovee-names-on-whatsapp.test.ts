/**
 * Smoovee prod 2026-11-13, WhatsApp conv cmwer1s5w0r0qkdj35329ql9i:
 * "אליס ואלכסה כמה זה" got "לא מצאתי כרגע ברשימת המוצרים את "אליס" או
 * "אלכסה"", though both are in Shop Smoovee (he 4057 / 1433, en 4046 / 54).
 *
 * Two causes, both fixed here:
 * 1. The model searched "alice" and "alexa" (Latin) and the store reads in
 *    Hebrew (storeLanguage he). The fixes that bring the customer's own words
 *    to the search, and retry an empty one in them, ran only on the website
 *    widget's turn (wooTurn), never on WhatsApp.
 * 2. Her store's own lang=he search answers NOTHING for "אלכסה" (live Store
 *    API, 2026-11-13), so even the customer's words found only Alice. A name
 *    is now also matched against the store's cached catalogue.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, assertPublicUrl: vi.fn(async () => undefined) };
});

import Woo from "../services/connectors/woocommerce.adapter";

const CATALOG: { he: any[]; en: any[] } = JSON.parse(readFileSync(join(__dirname, "fixtures/smoovee-catalog.json"), "utf8"));
const EN_CATS = [{ id: 63, name: "Accessories", count: 2 }, { id: 15, name: "Kitchen", count: 10 }, { id: 86, name: "Shop Smoovee", count: 12 }, { id: 99, name: "Smoovee Woody", count: 11 }];
const SHOP_EN = [10261, 4820, 4061, 4046, 2186, 2171, 450, 449, 444, 56, 54, 52];
const SHOP_HE = [32551, 4831, 4068, 4057, 2196, 2183, 611, 614, 620, 624, 1433, 634];
const CONFIG = { productCategoryIds: ["86", "87"], storeLanguage: "he" };

let n = 0;
/** Her store as it answered on 2026-11-13: titles only, and lang=he finds nothing for "אלכסה". */
function store(o: { blindHe?: RegExp } = { blindHe: /אלכס/ }) {
  const base = `https://smoovee-names${++n}.example.com`;
  const searches: string[] = [];
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const u = new URL(url);
    const he = u.searchParams.get("lang") === "he";
    const list = he ? CATALOG.he : CATALOG.en;
    let body: any = [];
    if (u.pathname.endsWith("/products/categories")) body = EN_CATS;
    else if (u.pathname.endsWith("/products")) {
      const q = u.searchParams.get("search") ?? "";
      if (q) searches.push(`${he ? "he" : "default"}:${q}`);
      const cat = u.searchParams.get("category");
      const shop = cat === "86" || cat === "87" ? (he ? SHOP_HE : SHOP_EN) : null;
      const inCat = shop ? list.filter((p) => shop.includes(p.id)) : list;
      const blind = he && o.blindHe && o.blindHe.test(q);
      const hits = !q ? inCat : blind ? [] : inCat.filter((p) => p.name.toLowerCase().includes(q.toLowerCase()));
      const page = Number(u.searchParams.get("page") ?? 1), per = Number(u.searchParams.get("per_page") ?? 10);
      body = hits.slice((page - 1) * per, page * per);
    }
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  }));
  const run = (args: Record<string, unknown>) =>
    Woo.execute({ toolName: "list_products", args, credentials: { consumerKey: "ck", consumerSecret: "cs" }, config: { storeUrl: base, ...CONFIG } } as any) as Promise<any[]>;
  return { run, searches };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const ids = (l: any[]) => l.map((p) => p.id).sort((a, b) => a - b);

describe("★ \"אליס ואלכסה כמה זה\" finds both", () => {
  it("the customer's words: Alice AND Alexa, Hebrew catalogue, Shop Smoovee only", async () => {
    const s = store();
    expect(ids(await s.run({ query: "אליס ואלכסה כמה זה" }))).toEqual([1433, 4057]);
    // The store's search really was asked and really missed Alexa.
    expect(s.searches).toContain("he:ואלכסה");
  });

  it("the model's Latin query with the customer's words riding along (what the bot now sends on WhatsApp)", async () => {
    const s = store();
    expect(ids(await s.run({ query: "alice", customer_query: "אליס ואלכסה כמה זה" }))).toEqual([1433, 4057]);
  });

  it("control: the model's Latin query alone, as on prod, finds nothing in the Hebrew catalogue", async () => {
    expect(await store().run({ query: "alice" })).toEqual([]);
    expect(await store().run({ query: "alexa" })).toEqual([]);
  });

  it("a single name the store's search misses: \"אלכסה\" is 1433 by its name", async () => {
    expect(ids(await store().run({ query: "אלכסה" }))).toEqual([1433]);
  });

  it("the catalogue match keeps the allow-list: \"וודי אליס\" (Woody, not in Shop Smoovee) is not offered", async () => {
    const got = await store().run({ query: "אליס" });
    expect(ids(got)).toEqual([4057]);
  });
});

describe("★ the bot sends the customer's words on every channel, not only the website widget", () => {
  const src = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf8");
  const block = src.slice(src.indexOf("These search fixes are the store's, on every channel."), src.indexOf("Fire-and-forget notification emit on success only."));

  it("the language, the customer's words, the size, the audience, the colour and the retry are not gated on the widget's turn", () => {
    expect(block.length).toBeGreaterThan(500);
    expect(block).toContain("customer_query: own");
    expect(block).toContain("retried in the customer's words");
    expect(block).not.toMatch(/&& wooTurn\b/);
    expect(block).not.toMatch(/\bwooTurn\)/);
  });
});
