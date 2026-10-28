/**
 * urban-e32 on 73d960f0 (2026-10-28).
 *
 *   U4 T2: "SHOW: PRODUCT_1" inline at the end of a sentence; the customer saw "SHOW".
 *   U5:    "יש לכם חולצה לבנה?" then "משהו מכותנה": searched "Shirts", came back as
 *          hoodies with no white; then "Dusty Rose" in a Hebrew reply.
 *   U4 T3: "עולה כ ₪25, ₪29": two prices for one shipping cost.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, assertPublicUrl: vi.fn(async () => undefined) };
});

import Woo, { rankByTitleWords } from "../services/connectors/woocommerce.adapter";
import { carriedColour } from "../services/woo-chat-turn.service";
import { takeShowLine, finalTextIssues, polishReply, askedColours } from "../services/reply-style-check.service";

describe("U4 T2: SHOW inline", () => {
  const MODEL = "נשמע — יש אופציה מתאימה בצעיפים שכנראה תאהב. SHOW: PRODUCT_1";
  it("is taken wherever it is, with its keys", () => {
    const r = takeShowLine(MODEL);
    expect(r.keys).toEqual(["PRODUCT_1"]);
    expect(r.text).toBe("נשמע — יש אופציה מתאימה בצעיפים שכנראה תאהב.");
    expect(takeShowLine("הנה שניים. SHOW: PRODUCT_2, PRODUCT_3\nאיזה צבע?").keys).toEqual(["PRODUCT_2", "PRODUCT_3"]);
  });
  it("a SHOW left anywhere never leaves", () => {
    const ctx = { locale: "he" as const, cardsShown: true, incomingMessage: "צעיף", shopFloor: true } as any;
    expect(finalTextIssues("נשמע, יש אופציה מתאימה בצעיפים שכנראה תאהב. SHOW", ctx)).toContain("show_line");
    expect(finalTextIssues("נשמע, יש צעיף. SHOW: Lambswool Scarf", ctx)).toContain("show_line");
    expect(finalTextIssues("יש צעיף רך שמתאים למתנה.", ctx)).not.toContain("show_line");
  });
});

describe("U5: a refinement keeps the kind and the colour", () => {
  const T1 = { direction: "INBOUND", body: "יש לכם חולצה לבנה?" };
  const A1 = { direction: "OUTBOUND", body: "יש כמה חולצות לבנות." };
  it("\"משהו מכותנה\" keeps white; T3 \"אני אקח אותה, יש במידה L?\" too", () => {
    expect(carriedColour([T1, A1], "משהו מכותנה", "Shirts")).toBe("white");
    expect(carriedColour([T1, A1, { direction: "INBOUND", body: "משהו מכותנה" }], "אני אקח אותה, יש במידה L?", "Cropped Hoodie")).toBe("white");
  });
  it("not when this message says its own colour or another kind, or the query has one", () => {
    expect(carriedColour([T1, A1], "יש בשחור?", "shirt")).toBeNull();
    expect(carriedColour([T1, A1], "ויש מעיל?", "coat")).toBeNull();
    expect(carriedColour([T1, A1], "משהו מכותנה", "white shirt")).toBeNull();
    expect(carriedColour([{ direction: "INBOUND", body: "יש לכם חולצה?" }], "משהו מכותנה", "shirt")).toBeNull();
  });
  it("a colour is a whole word: \"חומר\" is not brown, \"הלבנה\" is white", () => {
    expect(askedColours("מה החומר?")).toEqual([]);
    expect(askedColours("את הלבנה")).toEqual(["white"]);
  });
  it("wired: the colour goes into the model's search", () => {
    const bot = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf8");
    expect(bot).toContain("const colour = carriedColour(messages as any[], opts.incomingMessage, modelQuery);");
  });
  it("a Sweatshirt is not a shirt", () => {
    const ps = [{ name: "Crewneck Sweatshirt" }, { name: "Striped Cotton Shirt" }, { name: "Poplin Overshirt" }];
    expect(rankByTitleWords(ps, ["shirt"]).map((p) => p.name)).toEqual(["Striped Cotton Shirt", "Poplin Overshirt"]);
    expect(rankByTitleWords(ps, ["sweatshirt"]).map((p) => p.name)).toEqual(["Crewneck Sweatshirt"]);
  });
  it("\"Shirts\" with no title hit is the Shirts category, not Hoodies & Sweatshirts", async () => {
    const TREE = [
      { id: 51, name: "Hoodies &amp; Sweatshirts", parent: 48, count: 4 }, { id: 50, name: "Shirts", parent: 48, count: 4 },
      { id: 49, name: "T-Shirts", parent: 48, count: 5 },
    ];
    const SHIRTS = [{ id: 140, name: "Striped Cotton Shirt", categories: [{ id: 50 }] }, { id: 98, name: "Relaxed Linen Shirt", categories: [{ id: 50 }] }];
    const HOODIES = [{ id: 197, name: "Cropped Hoodie", categories: [{ id: 51 }] }];
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      const u = new URL(url);
      let body: any = [];
      if (u.pathname.endsWith("/products/categories")) body = TREE;
      else if (u.searchParams.get("category") === "50") body = SHIRTS;
      else if (u.searchParams.get("category") === "51") body = HOODIES;
      // Woo's search also reads the copy: the hoodies' copy says "sweatshirts".
      else if (u.searchParams.get("search")?.toLowerCase() === "cotton shirts") body = HOODIES;
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    }));
    const got: any[] = await Woo.execute({ toolName: "list_products", args: { query: "cotton shirts" }, credentials: { consumerKey: "ck", consumerSecret: "cs" }, config: { storeUrl: "https://e32.example.com" } } as any) as any;
    // The cotton one first.
    expect(got.map((p) => p.id)).toEqual([140, 98]);
  });
  afterEach(() => vi.unstubAllGlobals());
});

describe("U5 T3: colours in a Hebrew reply are Hebrew", () => {
  it.each([
    ["יש מידה L בצבע Ecru במלאי; ב‑Dusty Rose המידה L אזלה.", /Dusty|Rose|Ecru/],
    ["יש גם ב-Washed Black.", /Washed|Black/],
  ])("%s", (inp, latin) => {
    const out = polishReply(inp, { locale: "he", incomingMessage: "יש במידה L?" });
    expect(out).not.toMatch(latin);
  });
  it("Dusty Rose is one colour", () => {
    expect(polishReply("יש בצבע Dusty Rose.", { locale: "he", incomingMessage: "" })).toBe("יש בצבע ורוד מעושן.");
  });
});

describe("U4 T3: one shipping cost, never two prices", () => {
  const ctx = { locale: "he" as const, cardsShown: false, incomingMessage: "כמה עולה משלוח?", shopFloor: true } as any;
  it.each([
    "משלוח רגיל לישראל עולה כ ₪25, ₪29, וחינם מעל ₪299.",
    "משלוח רגיל לישראל עולה כ־₪25–₪29.",
    "משלוח רגיל עולה בין ₪25 ל־₪29.",
    "המשלוח עולה 25-29 ₪.",
  ])("two: %s", (t) => expect(finalTextIssues(t, ctx)).toContain("two_prices"));
  it.each([
    "משלוח רגיל עולה ₪29, וחינם בהזמנות מעל ₪299.",
    "יש תיקים בין ₪129 ל־₪549.",
    "עלות המשלוח המדויקת מוצגת בקופה, וחינם מעל ₪299.",
  ])("fine: %s", (t) => expect(finalTextIssues(t, ctx)).not.toContain("two_prices"));
  it("the prompt no longer asks for a range", () => {
    const pb = readFileSync(join(__dirname, "../services/prompt-builder.service.ts"), "utf8");
    expect(pb).not.toContain("say it plainly as a range");
    expect(pb).toContain("give neither number: for shipping, say the exact cost shows at checkout");
  });
});
