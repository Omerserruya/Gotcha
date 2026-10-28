/**
 * The supervisor's replay (2026-10-28, conv cmvrvcrk4000113qxu8xbm6vv), T3
 * "אקססורי חמוד" after "מתנה לבת זוגג שלי": the model searched
 * {"query":"accessory"}; no title holds the word, the store's own search of
 * category names misses "Accessories" too, and the customer got "מצטערים, לא
 * מצאנו אקססוריז שמתאימים לפי החיפוש המהיר." with the question cut away.
 *
 *   - an empty title search resolves its category by stem, for the person the
 *     conversation is shopping for;
 *   - "לפי החיפוש המהיר" names our source;
 *   - a bare apology or "not found" is never a reply.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, assertPublicUrl: vi.fn(async () => undefined) };
});

import Woo from "../services/connectors/woocommerce.adapter";
import { conversationAudience } from "../services/woo-chat-turn.service";
import { finalTextIssues, dropBrokenSentences, checkReplyStyle } from "../services/reply-style-check.service";

// The urban store's tree and accessories, as on dev (read-only SELECT).
const TREE = [
  { id: 56, name: "Accessories", parent: 0, count: 6 }, { id: 48, name: "Clothing", parent: 0, count: 0 },
  { id: 58, name: "Men", parent: 0, count: 25 }, { id: 57, name: "Women", parent: 0, count: 26 },
  { id: 54, name: "Jackets &amp; Coats", parent: 48, count: 5 }, { id: 55, name: "Dresses", parent: 48, count: 3 },
];
const p = (id: number, name: string, cats: number[]) => ({ id, name, status: "publish", catalog_visibility: "visible", categories: cats.map((id) => ({ id })) });
const ACCESSORIES = [
  p(421, "Canvas Tote Bag", [56, 57, 58]), p(425, "Leather Crossbody Bag", [56, 57]),
  p(429, "Ribbed Wool Beanie", [56, 57, 58]), p(450, "Mens Leather Wallet", [56, 58]),
];
const COATS = [p(329, "Wool Blend Overcoat", [54, 57, 58])];

let n = 0;
function store() {
  // A store of its own per test: the adapter caches categories per store.
  const base = `https://shop${++n}.example.com`;
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    calls.push(url);
    const u = new URL(url);
    let body: any = [];
    if (u.pathname.endsWith("/products/categories")) {
      const q = (u.searchParams.get("search") ?? "").toLowerCase();
      // WordPress: a substring of the name. "accessory" is not in "accessories".
      body = q ? TREE.filter((c) => c.name.toLowerCase().includes(q)) : TREE;
    } else if (u.pathname.endsWith("/products")) {
      const q = (u.searchParams.get("search") ?? "").toLowerCase();
      const cat = u.searchParams.get("category");
      const all = [...ACCESSORIES, ...COATS];
      body = cat ? all.filter((x) => x.categories.some((c) => String(c.id) === cat)) : q ? all.filter((x) => x.name.toLowerCase().includes(q)) : all;
    }
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  }));
  const run = (args: Record<string, unknown>) =>
    Woo.execute({ toolName: "list_products", args, credentials: { consumerKey: "ck", consumerSecret: "cs" }, config: { storeUrl: base } } as any) as Promise<any[]>;
  return { run, calls };
}
afterEach(() => vi.unstubAllGlobals());

// The replay, message by message, up to T3.
const HISTORY = [
  { direction: "INBOUND", body: "היי" },
  { direction: "OUTBOUND", body: "היי! מה מחפשים היום אצלנו בחנות?" },
  { direction: "INBOUND", body: "מחפש מתנה לבת זוגג שלי" },
  { direction: "OUTBOUND", body: "נשמע, מתנה לבת הזוג. להתמקד במעיל חם או בסוודר?" },
];

describe("T3 \"אקססורי חמוד\": the store HAS accessories", () => {
  it("the search is for her", () => {
    expect(conversationAudience(HISTORY, "אקססורי חמוד")).toBe("women");
    // The later "מעיל לגברים" moves it, as it moved the customer.
    expect(conversationAudience([...HISTORY, { direction: "INBOUND", body: "אקססורי חמוד" }], "אוקי ויש מעיל לגברים ?")).toBe("men");
    expect(conversationAudience([{ direction: "INBOUND", body: "היי" }], "אקססורי חמוד")).toBeNull();
  });
  it("\"accessory\" finds the Accessories category, and with the audience only hers", async () => {
    const s = store();
    const ids = (await s.run({ query: "accessory", audience: "women" })).map((x) => x.id);
    expect(ids).toEqual([421, 425, 429]);
    expect(s.calls.some((u) => /[?&]category=56(&|$)/.test(u))).toBe(true);
  });
  it("plural, singular and with no audience: the category still", async () => {
    for (const query of ["accessories", "accessory", "Accessories"]) {
      expect((await store().run({ query })).map((x) => x.id)).toEqual([421, 425, 429, 450]);
    }
    expect((await store().run({ query: "coats" })).map((x) => x.id)).toEqual([329]);
  });
  it("never the Men / Women category by name (that is the audience param's)", async () => {
    const s = store();
    await s.run({ query: "women" });
    expect(s.calls.some((u) => /[?&]category=57(&|$)/.test(u))).toBe(false);
  });
  it("wired: the conversation's audience goes with the model's search; the model's own stands", () => {
    const bot = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf8");
    expect(bot).toContain("if (toolFunctionName === \"woocommerce.list_products\" && wooTurn && effectiveArgs?.audience == null) {");
    expect(bot).toContain("const audience = conversationAudience(messages as any[], opts.incomingMessage);");
  });
});

describe("what was sent is never sent again", () => {
  const ctx = { locale: "he" as const, cardsShown: false, incomingMessage: "אקססורי חמוד", shopFloor: true } as any;
  const SENT = "מצטערים, לא מצאנו אקססוריז שמתאימים לפי החיפוש המהיר.";
  it("a bare apology over nothing is a dead end, and names our search", () => {
    const issues = finalTextIssues(SENT, ctx);
    expect(issues).toContain("dead_end");
    expect(issues).toContain("source_leak");
    // Dropping sentences cannot save it: the one clean rewrite, else the safe line.
    expect(dropBrokenSentences(SENT, ctx)).toBeNull();
  });
  it("the source phrase in any reply", () => {
    for (const t of ["לפי החיפוש המהיר יש שני תיקים.", "בחיפוש שלי מצאתי תיק.", "From a quick search, two bags."]) {
      expect(checkReplyStyle(t, { ...ctx, locale: /[a-z]/i.test(t[0]) ? "en" : "he" }).map((v) => v.kind)).toContain("source_leak");
    }
    expect(checkReplyStyle("אפשר לחפש לפי צבע.", ctx).map((v) => v.kind)).not.toContain("source_leak");
  });
  it.each([
    "מצטערים.",
    "לצערי לא מצאתי משהו כזה.",
    "Sorry, we couldn't find any accessories.",
  ])("dead end: %s", (t) => expect(finalTextIssues(t, { ...ctx, locale: /[a-z]/i.test(t) ? "en" : "he" })).toContain("dead_end"));
  it.each([
    "לא מצאתי אקססוריז כאלה. תיק או צעיף?",
    "אין לנו משלוח לאילת.",
    "לצערי המעיל אזל במידה L. יש במידה M.",
    "לצערי לא מצאתי במידה L, אבל יש במידה M.",
  ])("not a dead end: %s", (t) => expect(finalTextIssues(t, ctx)).not.toContain("dead_end"));
  it("over cards, an apology line is not the whole turn", () => {
    expect(finalTextIssues("לא מצאתי בדיוק את זה, אבל אלה קרובים:", { ...ctx, cardsShown: true })).not.toContain("dead_end");
  });
});

describe("T4 of the same replay: \"מציג את האפשרות שמתחת\" went out", () => {
  const ctx = { locale: "he" as const, cardsShown: true, incomingMessage: "אוקי ויש מעיל לגברים ?", shopFloor: true } as any;
  it("narrating the card below is caught at the gate", () => {
    expect(finalTextIssues("יש לנו מעיל ארוך וחם שמתאים לגברים, מציג את האפשרות שמתחת.", ctx)).toContain("card_narration");
  });
  it("\"מתחת ל\" is a place, not the cards", () => {
    expect(finalTextIssues("מעיל ארוך וחם שנכנס יפה מתחת לסוודר.", ctx)).not.toContain("card_narration");
  });
});
