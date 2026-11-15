/**
 * Smoovee prod 2026-11-13 to 11-15 (audit REPORT.md rows 3, 5, 7, 10, 12, 14):
 * what a mat fits is in its own "מתאים ל" list, and the search reached it only
 * when no title matched, without prefixes or plurals. "מיקרו", "מעמד", "בר מים",
 * "מעבד מזון" missed the right mats; "מיקסר" matched ten through a usage note;
 * two devices' sizes got every mat; a 49 x 32 base got "not found".
 * The fixture is her public catalogue (2026-11-08), mapped to wc/v3.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, assertPublicUrl: vi.fn(async () => undefined) };
});

import Woo, { descriptionTokens } from "../services/connectors/woocommerce.adapter";

const CATALOG: { he: any[]; en: any[] } = JSON.parse(readFileSync(join(__dirname, "fixtures/smoovee-catalog.json"), "utf8"));
const EN_CATS = [{ id: 63, name: "Accessories", count: 2 }, { id: 15, name: "Kitchen", count: 10 }, { id: 86, name: "Shop Smoovee", count: 12 }, { id: 99, name: "Smoovee Woody", count: 11 }];

// What her store answers for ?category=86 / 87 (public Store API, 2026-11-08):
// the same 12 per language, whatever each product's own categories list says.
const SHOP_EN = [10261, 4820, 4061, 4046, 2186, 2171, 450, 449, 444, 56, 54, 52];
const SHOP_HE = [32551, 4831, 4068, 4057, 2196, 2183, 611, 614, 620, 624, 1433, 634];
const SHOP_IDS: Record<string, number[]> = { "86": SHOP_EN, "87": SHOP_EN };

let n = 0;
function store(catalog = CATALOG, extra: Record<string, unknown> = {}) {
  const base = `https://smoovee${++n}.example.com`;
  const calls: string[] = [];
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    calls.push(decodeURIComponent(url));
    const u = new URL(url);
    let body: any = [];
    const list = u.searchParams.get("lang") === "he" ? catalog.he : catalog.en;
    const byId = /\/products\/(\d+)$/.exec(u.pathname);
    if (byId) body = [...catalog.he, ...catalog.en].find((p) => String(p.id) === byId[1]) ?? null;
    else if (u.pathname.endsWith("/products/categories")) body = EN_CATS;
    else if (u.pathname.endsWith("/products")) {
      const q = u.searchParams.get("search") ?? "";
      const page = Number(u.searchParams.get("page") ?? 1);
      const per = Number(u.searchParams.get("per_page") ?? 10);
      // Her store's search: titles only (search=Tami and search=תמי find nothing).
      const cat = u.searchParams.get("category");
      // Her store's category query, not the products' own (broken) category lists.
      const shop = u.searchParams.get("lang") === "he" ? (SHOP_IDS[cat ?? ""] ? SHOP_HE : []) : (SHOP_IDS[cat ?? ""] ?? []);
      const inCat = cat ? list.filter((p) => shop.includes(p.id)) : list;
      // Her store's search with lang=he (live run 2026-11-08) also reads the copy:
      // search=דגם returned five surfaces whose Hebrew text says "דגם".
      const he = u.searchParams.get("lang") === "he";
      const hits = q ? inCat.filter((p) => p.name.toLowerCase().includes(q.toLowerCase()) || (he && q.split(/\s+/).some((t) => t.length > 1 && `${p.short_description} ${p.description}`.includes(t)))) : inCat;
      const inStock = u.searchParams.get("stock_status") === "instock" ? hits.filter((x) => x.stock_status === "instock") : hits;
      body = inStock.slice((page - 1) * per, page * per);
    }
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  }));
  const run = (args: Record<string, unknown>) =>
    Woo.execute({ toolName: "list_products", args, credentials: { consumerKey: "ck", consumerSecret: "cs" }, config: { storeUrl: base, ...extra } } as any) as Promise<any[]>;
  const tool = (toolName: string, args: Record<string, unknown>) =>
    Woo.execute({ toolName, args, credentials: { consumerKey: "ck", consumerSecret: "cs" }, config: { storeUrl: base, ...extra } } as any) as Promise<any>;
  return { run, tool, calls, base };
}
const ids = (l: any[]) => l.map((p) => p.id);
const ASAF = [2196, 59846], CHRISTINA = [614, 59987], MONICA = [4068, 58377], ARIEL = [32551, 53932], ADAM = [2183, 59880], ALEXA = [1433, 59951], ALICE = [4057, 59820];
const GEFEN = [4831, 58347], MELANIE = [611];
// Her connection names the store language (WPML): a Hebrew turn reads the Hebrew catalogue.
const he = (args: Record<string, unknown>) => store(CATALOG, { storeLanguage: "he" }).run({ lang: "he", ...args });

describe("what the customer named is in a mat's own fit list", () => {
  it("\"מיקרו\" (the start of מיקרוגל) and \"מיקרוגל\": Asaf", async () => {
    for (const query of ["מיקרו", "מיקרוגל"]) {
      const got = await he({ query });
      expect(got.length).toBeGreaterThan(0);
      expect(got.every((p) => ASAF.includes(p.id))).toBe(true);
    }
  });
  it("\"בר מים\": Ariel and Adam (their lists say ברי מים), before the sold-out title hit", async () => {
    const got = await he({ query: "בר מים" });
    for (const fam of [ARIEL, ADAM]) expect(got.some((p) => fam.includes(p.id))).toBe(true);
    const soldOut = ids(got).indexOf(1878);
    expect(soldOut === -1 || got.slice(0, soldOut).length >= 3).toBe(true);
    expect(got[0].stock_status).toBe("instock");
  });
  it("\"מעמד לבר מים\": the same, the stand word names nothing", async () => {
    const got = await he({ query: "מעמד לבר מים" });
    expect(got.some((p) => ARIEL.includes(p.id))).toBe(true);
  });
  it("a construct plural in the list is the word: \"לבר\" is \"ברי מים\", \"מעבד\" is Gefen's \"מעבדי מזון\"", async () => {
    expect((await he({ query: "לבר" })).some((p) => ARIEL.includes(p.id))).toBe(true);
    expect((await he({ query: "מעבד" })).some((p) => GEFEN.includes(p.id))).toBe(true);
  });
  it("\"מעבד מזון\": Monica, Gefen, Melanie", async () => {
    const got = await he({ query: "מעבד מזון" });
    for (const fam of [MONICA, GEFEN, MELANIE]) expect(got.some((p) => fam.includes(p.id))).toBe(true);
  });
  it("\"מיקסר\": the mats whose list names a mixer, not the ones whose usage note mentions one", async () => {
    const got = await he({ query: "מיקסר" });
    expect(got.some((p) => CHRISTINA.includes(p.id))).toBe(true);
    expect(got.every((p) => [...CHRISTINA, ...ALICE, ...ASAF, 14814].includes(p.id))).toBe(true);
    expect(got.some((p) => ARIEL.includes(p.id))).toBe(false);
  });
  it("\"מעמד\" alone is the range, never nothing", async () => {
    expect((await he({ query: "מעמד" })).length).toBeGreaterThan(3);
  });
  it("a device in no list (\"נועם 3\"): nothing, and the store is one that sells by size", async () => {
    const s = store(CATALOG, { storeLanguage: "he" });
    expect(await s.run({ lang: "he", query: "נועם 3" })).toEqual([]);
    const { storeSellsBySize } = await import("../services/connectors/woocommerce.adapter");
    expect(storeSellsBySize(s.base)).toBe(true);
  });
  it("a fit list ends at its usage notes", async () => {
    const { fitListOf } = await import("../services/connectors/woocommerce.adapter");
    const ariel = CATALOG.he.find((p) => p.id === 32551);
    expect(fitListOf(ariel)).toMatch(/ברי מים/);
    expect(fitListOf(ariel)).not.toMatch(/מיקסר מכל דגם/);
  });
});

describe("the closest fit for each base size", () => {
  it("two devices, 21 x 24 and 22 x 35: Monica for the first, Christina for the second (the owner's picks)", async () => {
    const got = await he({ query: "משטח", fits_cm: [21, 24], fits_cm_all: [[21, 24], [22, 35]] });
    expect(got).toHaveLength(2);
    expect(MONICA).toContain(got[0].id);
    expect(got[0].fit_for).toEqual([21, 24]);
    expect(CHRISTINA).toContain(got[1].id);
    expect(got[1].fit_for).toEqual([22, 35]);
  });
  it("one size: the closest and a second choice of another size", async () => {
    const got = await he({ query: "משטח", fits_cm: [21, 24] });
    expect(MONICA).toContain(got[0].id);
    expect(got[1].second_choice).toBe(true);
    expect(got[1].footprint_cm[0] * got[1].footprint_cm[1]).not.toBe(got[0].footprint_cm[0] * got[0].footprint_cm[1]);
  });
  it("49 x 32 (the microwave): nothing fits, the largest is Asaf, marked too small", async () => {
    const got = await he({ query: "משטח", fits_cm: [49, 32] });
    expect(got).toHaveLength(1);
    expect(ASAF).toContain(got[0].id);
    expect(got[0].too_small).toBe(true);
  });
  it("the tolerance is 2 cm: a 21 x 24 base takes 20 x 25, a 23 x 27 base does not", async () => {
    const { closestFits, FIT_TOLERANCE_CM } = await import("../services/connectors/woocommerce.adapter");
    expect(FIT_TOLERANCE_CM).toBe(2);
    const mats = [{ id: 1, name: "מוניקה 20*25 ס\"מ" }, { id: 2, name: "כריסטינה 23*40 ס\"מ" }];
    expect(closestFits(mats, [[21, 24]])![0].id).toBe(1);
    expect(closestFits(mats, [[23, 27]])![0].id).toBe(2);
  });
});

describe("the customer's own words beside a generic query", () => {
  it("\"סמובי אלכסה שחור\" searched as \"משטח\": Alexa first", async () => {
    // Her live product page offers Alexa in לבן, שחור, במבוק (2026-11-15); the fixture has no attributes.
    const COLOURS = [{ name: "צבע", options: ["לבן", "שחור", "במבוק בהיר", "במבוק כהה"] }];
    const withColours = { ...CATALOG, he: CATALOG.he.map((p) => (ALEXA.includes(p.id) ? { ...p, attributes: COLOURS } : p)) };
    const got = await store(withColours, { storeLanguage: "he" }).run({ lang: "he", query: "משטח", customer_query: "סמובי אלכסה שחור" });
    expect(ALEXA).toContain(got[0].id);
  });
  it("a generic query is only stand words", async () => {
    const { genericStoreQuery } = await import("../services/connectors/woocommerce.adapter");
    expect(genericStoreQuery("משטח")).toBe(true);
    expect(genericStoreQuery("משטחים במלאי")).toBe(true);
    expect(genericStoreQuery("אלכסה")).toBe(false);
    expect(genericStoreQuery("scarf")).toBe(false);
  });
});

describe("what the model is told", () => {
  it("CLOSEST FIT per base, TOO SMALL for the largest, and a size question when a sized store finds nothing", async () => {
    const ps = await import("../services/product-search.service");
    const env = ps.normalizeWooProducts([
      { ...CATALOG.he.find((p) => p.id === 4068), matched_in: "dimensions", footprint_cm: [20, 25], fit_for: [21, 24] },
      { ...CATALOG.he.find((p) => p.id === 2196), matched_in: "dimensions", footprint_cm: [46, 33], fit_for: [49, 32], too_small: true },
    ], { storeUrl: "https://smoovee-ltd.com", storeCurrency: "ILS" });
    const sum = ps.buildKeyedModelSummary(env, "he", true);
    expect(sum).toMatch(/PRODUCT_1: [^\n]*CLOSEST FIT for the customer's 21 x 24 cm base/);
    expect(sum).toMatch(/PRODUCT_2: [^\n]*TOO SMALL: the store's LARGEST \(46 x 33 cm\)/);
    expect(sum).toMatch(/name each device with its CLOSEST FIT, one each, and never offer the whole list/);
    const empty = ps.normalizeWooProducts([], { storeUrl: "https://smoovee-ltd.com" });
    empty.sellsBySize = true;
    expect(ps.buildKeyedModelSummary(empty, "he", true)).toMatch(/ask, in one short question, for the device's base size/);
    const disc = readFileSync(join(__dirname, "../services/discovery-integration.service.ts"), "utf8");
    expect(disc).toContain("if (storeSellsBySize(storeUrl!)) env.sellsBySize = true;");
    const plain = ps.normalizeWooProducts([], { storeUrl: "https://x.example.com" });
    expect(ps.buildKeyedModelSummary(plain, "he", true)).not.toMatch(/base size/);
  });
});

describe("every size in the message", () => {
  it("his two devices, in order; one; none; and the short reply reads the message before", async () => {
    const { baseSizesAsked } = await import("../services/woo-chat-turn.service");
    expect(baseSizesAsked([], "יש לי 2 מכשירים:\nמג'ימיקס 21x24 סמ',\nמיקסר 22x35 סמ'\nאיזה משטחי הזזה שלכם מתאימים?")).toEqual([[21, 24], [22, 35]]);
    expect(baseSizesAsked([], "49 על 32")).toEqual([[49, 32]]);
    expect(baseSizesAsked([], "יש לכם משטח לבר מים?")).toEqual([]);
    expect(baseSizesAsked([{ direction: "INBOUND", body: "בסיס 40 על 20" }], "כן")).toEqual([[40, 20]]);
  });
  it("both search paths pass them all", () => {
    const src = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf8");
    expect(src.match(/fits_cm: sizes\[0\], fits_cm_all: sizes/g)?.length).toBe(2);
  });
});
