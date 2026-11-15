/**
 * Smoovee (prod 2026-11-08, cmw7p00cq00tkgpa6mubriuu5): "דגם לתמי 4" got "לא
 * מצאתי משטח שמתאים לתמי 4", yet the Alexa surface fits it. Its titles are
 * names ("סמובי אלכסה – משטח הזזה"); what a product fits is only in its short
 * description ("מתאים ל: תמי 4 באבלס"), which the store's own search does not
 * read. The store is WPML: lang=he is the Hebrew catalogue, with its own ids.
 *
 * The fixture is her public catalogue (Store API, 2026-11-08), both languages,
 * mapped to the wc/v3 shape.
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
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const fits = (p: any, re: RegExp) => re.test(String(p.short_description));

describe("words for a description match", () => {
  it("a prefix letter, a number, a Hebrew spelling of a Latin brand", () => {
    const t = descriptionTokens("דגם לתמי 4");
    expect(t.some((f) => f.includes("תמי"))).toBe(true);
    expect(t.some((f) => f.includes("4"))).toBe(true);
    expect(t.some((f) => f.includes("דגם"))).toBe(false);
    expect(descriptionTokens("ורטואו").flat()).toContain("vertuo");
    expect(descriptionTokens("למכונת").flat()).toEqual(expect.arrayContaining(["מכונ", "machine"]));
    expect(descriptionTokens("מכונות").flat()).toContain("מכונ");
  });
});

describe("Smoovee: what a product fits is in its description", () => {
  it("\"דגם לתמי 4\" is the Alexa, from the Hebrew catalogue", async () => {
    const s = store();
    const got = await s.run({ query: "דגם לתמי 4" });
    expect(got.map((p) => p.id).sort()).toEqual([1433, 59951]);
    expect(got.every((p) => fits(p, /תמי 4/))).toBe(true);
    expect(s.calls.some((u) => /lang=he/.test(u))).toBe(true);
    // Since 2026-11-15 the product's own "מתאים ל" list is read beside the title search.
    expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toMatch(/\[woo-search\] query="דגם לתמי 4" hit=fits_list results=2/);
  });
  it("\"תמי 4\" alone, and \"משטח לתמי 4\": the same two", async () => {
    for (const query of ["תמי 4", "משטח לתמי 4"]) {
      expect((await store().run({ query })).map((p) => p.id).sort()).toEqual([1433, 59951]);
    }
  });
  it("\"Tami 4\" is the Alexa, from the store's default (English) catalogue", async () => {
    const s = store();
    const got = await s.run({ query: "Tami 4" });
    expect(got.map((p) => p.id).sort()).toEqual([54, 59946]);
    expect(s.calls.some((u) => /lang=he/.test(u))).toBe(false);
  });
  it("\"משטח למכונת קפה ורטואו\" is the surfaces that list a Vertuo", async () => {
    const got = await store().run({ query: "משטח למכונת קפה ורטואו" });
    expect(got.length).toBeGreaterThan(0);
    expect(got.every((p) => fits(p, /vertuo/i))).toBe(true);
    expect(got.map((p) => p.id)).toEqual(expect.arrayContaining([614, 634]));
  });
  it("a word every product holds names nothing: \"משטח לטוסטר\" is empty, never every surface", async () => {
    expect(await store().run({ query: "משטח לטוסטר" })).toEqual([]);
    // A number alone never counts ("תמי 4" products hold the 4, but no coat does).
    expect(await store().run({ query: "מעיל 4" })).toEqual([]);
  });
  it("the catalogue is read once per ten minutes, per language", async () => {
    const s = store();
    await s.run({ query: "דגם לתמי 4" });
    await s.run({ query: "תמי 4 פרימו" });
    expect(s.calls.filter((u) => /page=1/.test(u) && /lang=he/.test(u)).length).toBe(1);
  });
  it("a name the title search finds is unchanged (\"אלכסה\", lang=he titles)", async () => {
    // The default catalogue has no Hebrew titles, so the name is found in the Hebrew one by its name.
    const got = await store().run({ query: "אלכסה" });
    expect(got.length).toBeGreaterThan(0);
    expect(got.every((p) => /אלכסה/.test(p.name))).toBe(true);
  });
  it("a catalogue over 200 products is not read whole", async () => {
    const many = Array.from({ length: 300 }, (_, i) => ({ id: i + 1, name: `Item ${i}`, status: "publish", catalog_visibility: "visible", stock_status: "instock", short_description: "Suitable for: Tami 4", description: "" }));
    const s = store({ he: many, en: many });
    expect(await s.run({ query: "Tami 4" })).toEqual([]);
    expect(s.calls.some((u) => /page=3/.test(u))).toBe(false);
  });
  it("sold out after in stock", async () => {
    const he = CATALOG.he.map((p) => (p.id === 1433 ? { ...p, stock_status: "outofstock" } : p));
    expect((await store({ he, en: CATALOG.en }).run({ query: "תמי 4" })).map((p) => p.id)).toEqual([59951, 1433]);
  });
});

describe("the knowledge chunker honours a section break (the onboarding products document)", () => {
  it("a form feed on its own line ends a chunk; a document without one is chunked as before", async () => {
    vi.doMock("../services/qdrant.service", () => ({ upsertChunks: vi.fn(), deleteByDocumentId: vi.fn() }));
    const { chunkDocument } = await import("../services/embedding.service");
    const doc = ["מספר מוצרים: 30", "סמובי אלכסה\nמתאים ל: · תמי 4 באבלס", "סמובי כריסטינה\nמתאים ל: · vertuo plus"].join("\n\f\n");
    expect(chunkDocument(doc)).toEqual(["מספר מוצרים: 30", "סמובי אלכסה\nמתאים ל: · תמי 4 באבלס", "סמובי כריסטינה\nמתאים ל: · vertuo plus"]);
    expect(chunkDocument("a b c")).toEqual(["a b c"]);
    const long = Array.from({ length: 1200 }, (_, i) => `w${i}`).join(" ");
    expect(chunkDocument(long).length).toBe(3);
    expect(chunkDocument(`${long}\n\f\nshort`).at(-1)).toBe("short");
  });
});

describe("an empty search is retried once in the customer's words (cmw7p00cq: \"דגם לתמי 4\" searched as \"plate\")", () => {
  it("a short reply (\"כן\") takes the ask before it; the model's own words are not retried", async () => {
    const { customerSearchQuery } = await import("../services/woo-chat-turn.service");
    const msgs = [{ direction: "INBOUND", body: "היי" }, { direction: "OUTBOUND", body: "היי! מה מחפשים?" }, { direction: "INBOUND", body: "דגם לתמי 4" }, { direction: "OUTBOUND", body: "למשטח שמתאים לתמי 4, נכון?" }, { direction: "INBOUND", body: "כן" }];
    expect(customerSearchQuery(msgs, "כן", "plate")).toBe("דגם לתמי 4 כן");
    expect(customerSearchQuery(msgs.slice(0, 3), "דגם לתמי 4", "plate")).toBe("דגם לתמי 4");
    expect(customerSearchQuery(msgs.slice(0, 3), "דגם לתמי 4", "דגם לתמי 4")).toBeNull();
    expect(customerSearchQuery([], "4", "plate")).toBeNull();
  });
  it("the retried words find the Alexa", async () => {
    expect((await store().run({ query: "דגם לתמי 4 כן" })).map((p) => p.id).sort()).toEqual([1433, 59951]);
    // The model's "plate" matches only the spec label "Plate: Perspex" of two
    // other surfaces: marked as a copy match, so the turn retries it.
    const plate = await store().run({ query: "plate" });
    expect(plate.every((p) => p.matched_in === "description" && !fits(p, /Tami 4/))).toBe(true);
  });
  it("the bot retries an empty woocommerce search once, and keeps the retry only when it found something", () => {
    const src = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf8");
    expect(src).toContain("const own = customerSearchQuery(messages as any[], opts.incomingMessage, effectiveArgs?.query);");
    expect(src).toMatch(/args: \{ \.\.\.effectiveArgs, query: own, kind: undefined, rank: undefined, customer_query: undefined \}/);
    expect(src).toMatch(/\(result as any\)\.result\.length === 0 \|\| copyOnly\(\(result as any\)\.result\)\)/);
    expect(src).toMatch(/if \(again\.ok && Array\.isArray\(\(again as any\)\.result\) && \(again as any\)\.result\.length\) result = again;/);
  });
});

// "Shop Smoovee": 86 in the default language, 87 in Hebrew; "Smoovee Woody" is 99 / 100.
const SHOP = { productCategoryIds: ["86", "87"] };
const inShop = (p: any) => [...SHOP_EN, ...SHOP_HE].includes(p.id);

describe("a connection that allows only some categories (Smoovee: only Shop Smoovee can be ordered)", () => {
  it("\"מה יש כרגע במלאי\" shows no Woody (cmw7p00cq 10:45Z: Woody Alexa, Adam, Asaf)", async () => {
    const got = await store(CATALOG, SHOP).run({ query: "מה יש כרגע במלאי" });
    expect(got.length).toBeGreaterThan(0);
    expect(got.every(inShop)).toBe(true);
    expect(got.some((p) => /woody|וודי/i.test(p.name))).toBe(false);
  });
  it("a browse with no words (in_stock only) is the allowed products, though the newest ten are all Woody", async () => {
    const got = await store(CATALOG, SHOP).run({ in_stock: true, per_page: 10, lang: "he" });
    expect(got.length).toBeGreaterThan(0);
    expect(got.length).toBeLessThanOrEqual(10);
    expect(got.every(inShop)).toBe(true);
  });
  it("every route: the description match, a Latin ask, a name", async () => {
    expect((await store(CATALOG, SHOP).run({ query: "דגם לתמי 4" })).map((p) => p.id)).toEqual([1433]);
    expect((await store(CATALOG, SHOP).run({ query: "Tami 4" })).map((p) => p.id)).toEqual([54]);
    const names = await store(CATALOG, SHOP).run({ query: "אלכסה" });
    expect(names.length).toBeGreaterThan(0);
    expect(names.every(inShop)).toBe(true);
  });
  it("a card: get_product and the two-minute listing never give a product outside them", async () => {
    const s = store(CATALOG, SHOP);
    await s.run({ query: "Smoovee" });
    const { recentlyListedWooProduct } = await import("../services/connectors/woocommerce.adapter");
    expect(recentlyListedWooProduct(s.base, "59951")).toBeNull(); // Woody Alexa (he)
    await expect(s.tool("get_product", { product_id: "59951" })).rejects.toThrow(/product_not_found/);
    expect((await s.tool("get_product", { product_id: "1433" })).id).toBe(1433);
  });
  it("no allow-list: Woody is a product like any other (today's behaviour)", async () => {
    const s = store();
    expect((await s.tool("get_product", { product_id: "59951" })).id).toBe(59951);
    expect((await s.run({ query: "דגם לתמי 4" })).map((p) => p.id).sort()).toEqual([1433, 59951]);
  });
});

describe("a store that reads products in the conversation's language (WPML)", () => {
  it("storeLanguage he: a Hebrew turn reads lang=he, names and ids of the Hebrew catalogue", async () => {
    const s = store(CATALOG, { storeLanguage: "he" });
    const got = await s.run({ query: "Smoovee", lang: "he" });
    expect(s.calls.filter((u) => /\/products\?/.test(u)).every((u) => /lang=he/.test(u))).toBe(true);
    await s.tool("get_product", { product_id: "1433" });
    expect(s.calls.at(-1)).toMatch(/\/products\/1433\?lang=he$/);
    expect(got).toBeDefined();
  });
  it("a product's variations are read in that language too (Smoovee 4057 carded with none)", async () => {
    const s = store(CATALOG, { storeLanguage: "he" });
    await s.tool("list_product_variations", { product_id: "4057", per_page: 30 });
    expect(s.calls.at(-1)).toMatch(/\/products\/4057\/variations\?per_page=30&lang=he$/);
    const t = store();
    await t.tool("list_product_variations", { product_id: "4057", per_page: 30 });
    expect(t.calls.at(-1)).toMatch(/\/products\/4057\/variations\?per_page=30$/);
  });
  it("an English turn on that store reads lang=en", async () => {
    const s = store(CATALOG, { storeLanguage: "he" });
    await s.run({ query: "Tami 4", lang: "en" });
    expect(s.calls.filter((u) => /\/products\?/.test(u)).every((u) => /lang=en/.test(u))).toBe(true);
  });
  it("a store without storeLanguage: no lang parameter at all, whatever the turn says (Tehila's store)", async () => {
    const s = store();
    await s.run({ query: "Tami 4", lang: "he" });
    await s.tool("get_product", { product_id: "54", lang: "he" });
    expect(s.calls.some((u) => /lang=/.test(u))).toBe(false);
  });
});

describe("the store's own search reads copy in Hebrew: a title hit must hold the word (live run 2026-11-08)", () => {
  it("\"דגם לתמי 4\" on the Hebrew catalogue is the Alexa, not five surfaces whose copy says דגם", async () => {
    const got = await store(CATALOG, { ...SHOP, storeLanguage: "he" }).run({ query: "דגם לתמי 4", lang: "he" });
    expect(got.map((p) => p.id)).toEqual([1433]);
  });
  it("a name still finds its product (\"אלכסה\", lang=he)", async () => {
    const got = await store(CATALOG, { ...SHOP, storeLanguage: "he" }).run({ query: "אלכסה", lang: "he" });
    expect(got.map((p) => p.id)).toEqual([1433]);
  });
});

describe("what fits a base size (cmw7r76pj 11:33: a 40 x 20 mixer base was offered Alice 31 x 41)", () => {
  // 2026-11-15 (Supervisor, Omer): a mat may be up to 2 cm smaller per side.
  // The owner herself put Monica 20 x 25 under a 21 x 24 Magimix (prod
  // cmwgwzvr, 11-15 09:38), so 34 x 40 now takes Ariel 34 x 38; the 11-08
  // strict rule said "nothing".
  it("the supervisor's three: 40x20 Christina, 30x20 Gefen, 34x40 Ariel (2 cm tolerance)", async () => {
    const ids = async (fits_cm: number[]) => (await store(CATALOG, { ...SHOP, storeLanguage: "he" }).run({ query: "mixer", fits_cm, lang: "he" })).map((p) => p.id);
    expect((await ids([40, 20]))[0]).toBe(614);   // כריסטינה 23*40
    expect((await ids([30, 20]))[0]).toBe(4831);  // גפן 20*30
    expect((await ids([34, 40]))[0]).toBe(32551); // אריאל 34*38
  });
  it("smallest first, either way round, marked for the model", async () => {
    const got = await store(CATALOG, { ...SHOP, storeLanguage: "he" }).run({ query: "x", fits_cm: [20, 40], lang: "he" });
    expect(got[0].id).toBe(614);
    expect(got.every((p) => p.matched_in === "dimensions")).toBe(true);
    const area = (p: any) => p.footprint_cm[0] * p.footprint_cm[1];
    expect(got.map(area)).toEqual([...got.map(area)].sort((a, b) => a - b));
  });
  it("a store whose products name no size searches as usual", async () => {
    const plain = { he: CATALOG.he.map((p) => ({ ...p, name: "מוצר", short_description: "" })), en: CATALOG.en.map((p) => ({ ...p, name: "Item", short_description: "" })) };
    const got = await store(plain).run({ query: "Tami 4", fits_cm: [40, 20] });
    expect(got.some((p) => p.matched_in === "dimensions")).toBe(false);
  });
  it("the size the customer gave, from their words", async () => {
    const { baseSizeAsked } = await import("../services/woo-chat-turn.service");
    expect(baseSizeAsked([], "הבסיס של המיקסר 40 על 20")).toEqual([40, 20]);
    expect(baseSizeAsked([], "40x20 ס\"מ")).toEqual([40, 20]);
    expect(baseSizeAsked([{ direction: "INBOUND", body: "קיצ'נאייד, בסיס 40×20" }], "כן")).toEqual([40, 20]);
    expect(baseSizeAsked([], "יש לכם משהו לתמי 4?")).toBeNull();
  });
  it("the bot passes the customer's base size on its Woo searches", () => {
    const src = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf8");
    expect(src).toContain("const sizes = baseSizesAsked(messages as any[], opts.incomingMessage);");
    expect(src).toContain("if (sizes.length) effectiveArgs = { ...effectiveArgs, fits_cm: sizes[0], fits_cm_all: sizes };");
  });
  it("the model is told the store picked them and to recommend the first", async () => {
    const { normalizeWooProducts, buildKeyedModelSummary } = await import("../services/product-search.service");
    const got = await store(CATALOG, { ...SHOP, storeLanguage: "he" }).run({ query: "x", fits_cm: [40, 20], lang: "he" });
    const s = buildKeyedModelSummary(normalizeWooProducts(got, { storeUrl: "https://smoovee-ltd.com", storeCurrency: "ILS" }), "he", true);
    expect(s).toMatch(/PRODUCT_1: "סמובי כריסטינה[^"]*" .*CLOSEST FIT for the customer's 40 x 20 cm base \(its size 23 x 40 cm\)/);
    expect(s).toMatch(/A product marked CLOSEST FIT for a base is the one to recommend for that base/);
  });
});
