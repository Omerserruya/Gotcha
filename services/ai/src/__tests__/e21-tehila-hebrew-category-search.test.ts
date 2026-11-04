/**
 * Tehila (One Of A Kind, prod 2026-11-01..04): her product titles are NAMES
 * ("אנה", "פרינט- קרואלה"), so no title holds "מטפחת" and every scarf ask
 * ended in "לא מצאתי". Her 83 scarves are reachable only by her Hebrew
 * categories, which the category fallback never matched (Latin words only).
 *
 *   - a Hebrew ask resolves her category by stem: מטפחה / מטפחת / מטפחות are one;
 *   - the narrowest category that holds all the words: "מטפחה חגיגית" is
 *     "מטפחות חגיגיות", not every scarf;
 *   - "הקולקציה החדשה" is her "new in";
 *   - a name with a kind ("מטפחת אנה") puts Anna first;
 *   - an empty ask retries the word's other forms (סיכה -> סיכת);
 *   - in stock first; the English "scarf" on her Hebrew store finds the scarves;
 *   - the urban (English) store's searches are unchanged (their own tests).
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, assertPublicUrl: vi.fn(async () => undefined) };
});

import Woo, { hebrewStem, hebrewVariants, queryStems, recentlyListedWooProduct } from "../services/connectors/woocommerce.adapter";

// Her category tree as her store serves it (public Store API, 2026-11-04), entities and all.
const TREE = [
  { id: 139, name: "2 ב250", count: 1 }, { id: 35, name: "new in", count: 27 }, { id: 15, name: "Uncategorized", count: 10 },
  { id: 19, name: "מטפחות", count: 83 }, { id: 123, name: "מטפחות &#8211; NEW", count: 27 },
  { id: 20, name: "מטפחות חגיגיות", count: 73 }, { id: 24, name: "מטפחות יומיום", count: 71 },
  { id: 30, name: "עגילים", count: 12 }, { id: 28, name: "שרשראות", count: 23 }, { id: 27, name: "תכשיטים", count: 39 },
  { id: 126, name: "עד 99 ש&quot;ח", count: 43 },
];
const p = (id: number, name: string, cats: number[], stock = "instock") =>
  ({ id, name, status: "publish", catalog_visibility: "visible", stock_status: stock, categories: cats.map((c) => ({ id: c })) });
const PRODUCTS = [
  p(25563, "פרינט- קרואלה", [19, 20, 35, 123]), p(25493, "אנה", [19, 20]), p(25473, "טיאנה", [19, 20], "outofstock"),
  p(25454, "פוקהונטס", [19, 24]), p(25439, "מיראבל", [19, 24, 35]),
  p(31001, "עגילי פרח", [27, 30]), p(31002, "סיכת פטנט למטפחת", [27]),
];

let n = 0;
function store() {
  const base = `https://tehila${++n}.example.com`;
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    calls.push(decodeURIComponent(url));
    const u = new URL(url);
    let body: any = [];
    if (u.pathname.endsWith("/products/categories")) body = TREE;
    else if (u.pathname.endsWith("/products")) {
      const q = u.searchParams.get("search") ?? "";
      const cat = u.searchParams.get("category");
      // Woo: a substring of the title (her titles never hold "מטפחת" alone).
      body = cat ? PRODUCTS.filter((x) => x.categories.some((c) => String(c.id) === cat)) : q ? PRODUCTS.filter((x) => x.name.includes(q)) : PRODUCTS;
    }
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  }));
  const run = (args: Record<string, unknown>) =>
    Woo.execute({ toolName: "list_products", args, credentials: { consumerKey: "ck", consumerSecret: "cs" }, config: { storeUrl: base } } as any) as Promise<any[]>;
  return { run, calls };
}
afterEach(() => vi.unstubAllGlobals());

describe("Hebrew stems", () => {
  it("one stem for a word's forms", () => {
    for (const w of ["מטפחה", "מטפחת", "מטפחות"]) expect(hebrewStem(w)).toBe("מטפח");
    expect(hebrewStem("חגיגית")).toBe(hebrewStem("חגיגיות"));
    expect(hebrewStem("החדשה")).toBe("חדש");
    expect(hebrewStem("עגילים")).toBe(hebrewStem("עגיל"));
    expect(hebrewStem("שרשראות")).toBe(hebrewStem("שרשרת"));
  });
  it("the other forms of a word, for a retry", () => {
    expect(hebrewVariants("סיכה")).toEqual(expect.arrayContaining(["סיכת", "סיכות"]));
    expect(hebrewVariants("סיכה")).not.toContain("סיכה");
  });
  it("store words only: 'יש לכם' and 'עד' name nothing", () => {
    expect(queryStems("יש לכם עד")).toEqual([]);
    expect(queryStems("הקולקציה החדשה")).toContain("new");
  });
});

describe("her asks, from the prod conversations", () => {
  it("\"מטפחה חגיגית\" is her festive scarves, in stock first", async () => {
    const s = store();
    const ids = (await s.run({ query: "מטפחה חגיגית" })).map((x) => x.id);
    expect(s.calls.some((u) => /[?&]category=20(&|$)/.test(u))).toBe(true);
    expect(ids.slice(0, 2)).toEqual(expect.arrayContaining([25563, 25493]));
    expect(ids.indexOf(25473)).toBeGreaterThan(ids.indexOf(25493)); // out of stock after
    expect(ids).not.toContain(25454); // an everyday scarf is not festive
  });
  it("\"מטפחת\" / \"מטפחות\" / \"מטפחה\" is all her scarves", async () => {
    for (const query of ["מטפחת", "מטפחות", "מטפחה", "יש לכם מטפחות?"]) {
      const s = store();
      const ids = (await s.run({ query })).map((x) => x.id);
      expect(s.calls.some((u) => /[?&]category=19(&|$)/.test(u))).toBe(true);
      expect(ids).toEqual(expect.arrayContaining([25563, 25493, 25454, 25439]));
    }
  });
  it("\"הקולקציה החדשה\" is her new-in", async () => {
    const s = store();
    const ids = (await s.run({ query: "הקולקציה החדשה" })).map((x) => x.id);
    expect(s.calls.some((u) => /[?&]category=35(&|$)/.test(u))).toBe(true);
    expect(ids).toEqual([25563, 25439]);
  });
  it("\"מטפחת אנה\": Anna first", async () => {
    const ids = (await store().run({ query: "מטפחת אנה" })).map((x) => x.id);
    expect(ids[0]).toBe(25493);
  });
  it("\"עגילים\" is her earrings", async () => {
    expect((await store().run({ query: "עגילים" })).map((x) => x.id)).toEqual([31001]);
  });
  it("no category, no title: the word's other form (סיכה -> סיכת)", async () => {
    const s = store();
    const ids = (await s.run({ query: "סיכה" })).map((x) => x.id);
    expect(ids).toEqual([31002]);
  });
  it("nothing anywhere: empty, never a wrong product", async () => {
    expect(await store().run({ query: "מעיל" })).toEqual([]);
  });
  it("the English \"scarf\" on her Hebrew store finds the scarves", async () => {
    const s = store();
    const ids = (await s.run({ query: "scarf" })).map((x) => x.id);
    expect(s.calls.some((u) => /[?&]category=19(&|$)/.test(u))).toBe(true);
    expect(ids.length).toBeGreaterThanOrEqual(4);
  });
});

describe("a card for a product the store just listed costs no more reads", () => {
  it("the listing is kept two minutes, by store and id; another store's is not", async () => {
    const s = store();
    await s.run({ query: "מטפחה חגיגית" });
    const base = new URL(s.calls.find((u) => u.includes("/products?"))!).origin;
    expect(recentlyListedWooProduct(base, "25493")?.name).toBe("אנה");
    expect(recentlyListedWooProduct(base + "/", "25493")?.name).toBe("אנה");
    expect(recentlyListedWooProduct("https://other.example.com", "25493")).toBeNull();
    expect(recentlyListedWooProduct(base, "99999")).toBeNull();
    vi.useFakeTimers({ now: Date.now() + 3 * 60_000 });
    try { expect(recentlyListedWooProduct(base, "25493")).toBeNull(); } finally { vi.useRealTimers(); }
  });
});
