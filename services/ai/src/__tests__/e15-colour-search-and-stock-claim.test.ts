/**
 * "ויש חולצה לבנה?" (dev, 2026-10-26, conv cmvp9gs3s…): the bot searched
 * list_products "white", got nothing, and said "כרגע לא נמצאה חולצה לבנה
 * במלאי". The Oxford Button-Down Shirt comes in white, S to XL, all in stock.
 *
 * Two causes, two fixes:
 *   - Woo's search reads titles and copy, never a variation's attributes, and
 *     our title filter then dropped whatever the copy matched. A colour or a
 *     size is now taken out of the search and matched against the product's
 *     own options.
 *   - The tool note said "never say it is out of stock", and the reply did.
 *     "לא נמצאה ... במלאי" was not in the checker's absence list, and the
 *     rewrite is never re-checked: now it is, with a plain line as backstop.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@chatcenter/shared", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  assertPublicUrl: vi.fn(async () => undefined),
}));

import Woo, { attributeWords, offersAttributes } from "../services/connectors/woocommerce.adapter";
import { checkReplyStyle, notFoundByNameLine } from "../services/reply-style-check.service";

const STORE = "https://demo-store.example.com";
const product = (id: number, name: string, options: Record<string, string[]>, o: any = {}) => ({
  id, name, status: "publish", catalog_visibility: "visible", type: "variable", price: "199", stock_status: "instock",
  attributes: Object.entries(options).map(([n, opts]) => ({ name: n, options: opts, variation: true })),
  ...o,
});
const OXFORD = product(117, "Oxford Button-Down Shirt", { Color: ["Light Blue", "White"], Size: ["S", "M", "L", "XL"] });
const POPLIN = product(201, "Poplin Overshirt", { Color: ["Sky", "Sand"], Size: ["M", "L"] });
const TEE = product(300, "Boxy Tee", { Color: ["Off-White", "Black"], Size: ["XS", "S"] });
const LAMP = { id: 41, name: "White Oak Lamp", status: "publish", catalog_visibility: "visible", type: "simple", price: "149", stock_status: "instock" };

const H = vi.hoisted(() => ({ fetches: [] as string[] }));

beforeEach(() => {
  H.fetches = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    H.fetches.push(url);
    const u = new URL(url);
    const q = (u.searchParams.get("search") ?? "").toLowerCase();
    let body: any[] = [];
    if (u.pathname.endsWith("/products/categories")) body = [];
    else if (u.pathname.endsWith("/products")) {
      const all = [OXFORD, POPLIN, TEE, LAMP];
      // Woo: a phrase is one substring of the title or the copy; no search = the catalogue.
      body = q ? all.filter((p) => p.name.toLowerCase().includes(q)) : all;
    }
    return { ok: true, status: 200, json: async () => body, text: async () => "" };
  }));
});
afterEach(() => vi.unstubAllGlobals());

const run = (args: any) =>
  Woo.execute({ toolName: "list_products", args, credentials: { consumerKey: "ck", consumerSecret: "cs" }, config: { storeUrl: STORE } } as any) as Promise<any[]>;
const searched = () => H.fetches.map((f) => new URL(f)).filter((u) => u.pathname.endsWith("/products")).map((u) => u.searchParams.get("search"));

describe("a colour or a size is matched on the product, not searched in titles", () => {
  it("\"white\" alone: the white Oxford shirt (it was [] before)", async () => {
    const out = await run({ query: "white", in_stock: true, per_page: 10 });
    expect(out.map((p) => p.id)).toEqual([117, 41]);
    // No noun to search: the catalogue's first 50, matched on options and titles.
    expect(searched()).toEqual([null]);
    expect(new URL(H.fetches[0]!).searchParams.get("per_page")).toBe("50");
    expect(new URL(H.fetches[0]!).searchParams.get("stock_status")).toBe("instock");
  });

  it("\"white shirt\": the noun is searched, the colour kept as a filter", async () => {
    const out = await run({ query: "white shirt" });
    expect(searched()[0]).toBe("shirt");
    expect(out.map((p) => p.id)).toEqual([117]); // the Poplin Overshirt comes in no white
  });

  it("a size too: \"shirt XL\" keeps only what comes in XL", async () => {
    expect((await run({ query: "shirt XL" })).map((p) => p.id)).toEqual([117]);
    expect((await run({ query: "shirt in M" })).map((p) => p.id).sort()).toEqual([117, 201]);
  });

  it("colour and size together must both be offered", async () => {
    expect((await run({ query: "white tee XS" })).map((p) => p.id)).toEqual([]);
    expect((await run({ query: "off-white tee XS" })).map((p) => p.id)).toEqual([300]);
  });

  it("\"blue\" matches \"Light Blue\" as a word, never inside another word", async () => {
    expect((await run({ query: "blue shirt" })).map((p) => p.id)).toEqual([117]);
    expect(offersAttributes(product(1, "X", { Color: ["Bluebell"] }), ["blue"], [])).toBe(false);
  });

  it("no colour or size: the search is exactly as before", async () => {
    await run({ query: "shirt" });
    expect(searched()).toEqual(["shirt"]);
  });

  it("never more than asked for", async () => {
    expect((await run({ query: "white", per_page: 1 })).length).toBe(1);
  });
});

describe("attributeWords", () => {
  it("splits colour and size words from the noun", () => {
    expect(attributeWords("white shirt")).toEqual({ rest: "shirt", colours: ["white"], sizes: [] });
    expect(attributeWords("Black Chino Pants size M")).toEqual({ rest: "chino pants", colours: ["black"], sizes: ["m"] });
    expect(attributeWords("off-white tee")).toEqual({ rest: "tee", colours: ["off-white"], sizes: [] });
    expect(attributeWords("hoodie")).toEqual({ rest: "hoodie", colours: [], sizes: [] });
    expect(attributeWords("")).toEqual({ rest: "", colours: [], sizes: [] });
  });
});

describe("the reply may not say it is out of stock after an empty search", () => {
  const ctx = (searchesAllEmpty: boolean) => ({
    locale: "he" as const, isFirstReply: false, incomingMessage: "ויש חולצה לבנה?", productFactsAvailable: true,
    shopFloor: true, toolsOffered: ["woocommerce.list_products"], customerClosing: false, searchesAllEmpty,
  });
  const absence = (text: string, empty = true) => checkReplyStyle(text, ctx(empty)).some((v) => v.kind === "false_absence");

  it("the sentence that went out is caught", () => {
    expect(absence("כרגע לא נמצאה חולצה לבנה במלאי.\nלהראות חולצות בצבע אוף וייט או טבעי במקום?")).toBe(true);
  });
  it("every form of the stock claim", () => {
    for (const t of ["לא נמצא מעיל כזה במלאי.", "לא נמצאו חולצות במלאי.", "זה לא במלאי כרגע.", "החולצה הלבנה לא זמינה במלאי.", "אין במלאי חולצה לבנה.", "אזלה מהמלאי.", "חסרה במלאי.", "It's out of stock."]) {
      expect(absence(t), t).toBe(true);
    }
  });
  it("the honest wording is not", () => {
    expect(absence("לא מצאתי חולצה לבנה בשם הזה. לחפש לפי סוג?")).toBe(false);
  });
  it("only after an EMPTY search: with a result in hand a stock answer may be true", () => {
    expect(absence("המידה M לא במלאי, יש ב‑L.", false)).toBe(false);
  });
  it("the backstop line makes no stock claim, in either language", () => {
    expect(absence(notFoundByNameLine("he"))).toBe(false);
    expect(checkReplyStyle(notFoundByNameLine("en"), { ...ctx(true), locale: "en" }).some((v) => v.kind === "false_absence")).toBe(false);
  });
});

describe("W01: a colour asked, the cards are only what was checked and has it", () => {
  // "יש חולצה לבנה?" (dev, 2026-10-26): the model searched "shirt", the first
  // four results were checked for white, and the fifth, Striped Cotton Shirt
  // (blue only), was carded unchecked.
  const src = require("fs").readFileSync(require("path").join(__dirname, "../services/ai-bot.service.ts"), "utf8") as string;
  it("a checked product with the colour is a hit; every other candidate is kept off the cards", () => {
    expect(src).toContain("if (has) colourHits.add(String(id));");
    expect(src).toContain("for (const c of envlp.candidates) if (!colourHits.has(String(c.productId))) colourMisses.add(String(c.productId));");
    // ...and the misses are what the card plan excludes.
    expect(src).toContain("excludeIds: colourMisses,");
  });
});
