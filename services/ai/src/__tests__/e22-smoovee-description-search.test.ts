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

let n = 0;
function store(catalog = CATALOG) {
  const base = `https://smoovee${++n}.example.com`;
  const calls: string[] = [];
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    calls.push(decodeURIComponent(url));
    const u = new URL(url);
    let body: any = [];
    const list = u.searchParams.get("lang") === "he" ? catalog.he : catalog.en;
    if (u.pathname.endsWith("/products/categories")) body = EN_CATS;
    else if (u.pathname.endsWith("/products")) {
      const q = u.searchParams.get("search") ?? "";
      const page = Number(u.searchParams.get("page") ?? 1);
      const per = Number(u.searchParams.get("per_page") ?? 10);
      // Her store's search: titles only (search=Tami and search=תמי find nothing).
      const hits = q ? list.filter((p) => p.name.toLowerCase().includes(q.toLowerCase())) : list;
      body = hits.slice((page - 1) * per, page * per);
    }
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  }));
  const run = (args: Record<string, unknown>) =>
    Woo.execute({ toolName: "list_products", args, credentials: { consumerKey: "ck", consumerSecret: "cs" }, config: { storeUrl: base } } as any) as Promise<any[]>;
  return { run, calls };
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
    expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toMatch(/\[woo-search\] query="דגם לתמי 4" hit=description results=2/);
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
    expect(src).toMatch(/args: \{ \.\.\.effectiveArgs, query: own, kind: undefined, rank: undefined \}/);
    expect(src).toMatch(/\(result as any\)\.result\.length === 0 \|\| copyOnly\(\(result as any\)\.result\)\)/);
    expect(src).toMatch(/if \(again\.ok && Array\.isArray\(\(again as any\)\.result\) && \(again as any\)\.result\.length\) result = again;/);
  });
});
