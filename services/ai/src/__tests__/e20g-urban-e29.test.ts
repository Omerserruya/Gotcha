/** urban-e29 (dev 2026-10-27): the white shirt again, "מוצגות" over nothing, short replies. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkReplyStyle, finalTextIssues, dropBrokenSentences, transliteratedTitleWord, type FinalGateContext, type StyleCheckContext } from "../services/reply-style-check.service";
import { attributeUnsearched } from "../services/ai-bot.service";

const ctx = (o: Partial<StyleCheckContext> = {}): StyleCheckContext => ({
  locale: "he", isFirstReply: true, incomingMessage: "יש לכם חולצה לבנה?", productFactsAvailable: true, shopFloor: true,
  toolsOffered: [], customerClosing: false, ...o,
});
const gate = (o: Partial<FinalGateContext> = {}): FinalGateContext => ({ ...ctx({ shopFloor: false }), cardsShown: false, productTitles: [], ...o });
const bot = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf8");

describe("presearch (a) and P2 step aside on a colour or a size", () => {
  it("both guards", () => {
    expect(bot).toContain(`if (preSearchEnabled() && disc.decision.query && !mentionsAudience(messages as any[], opts.incomingMessage)
          && !askedColours(opts.incomingMessage ?? "").length && !asksSize(opts.incomingMessage ?? "")) {`);
    expect(bot).toContain(`    && !askedColours(opts.incomingMessage ?? "").length && !asksSize(opts.incomingMessage ?? "")) {
    const last = await lastSearchArgs`);
  });
});

describe("\"we don't have it\" after a search that never asked for the colour", () => {
  const search = (query: string) => ({ tool: "woocommerce.list_products", args: { query } });
  it("searched without it: unsearched", () => {
    expect(attributeUnsearched("יש לכם חולצה לבנה?", [search("shirts")])).toBe(true);
    expect(attributeUnsearched("יש לכם חולצה לבנה?", [])).toBe(true);
  });
  it("searched with it, or read the product's variations: searched", () => {
    expect(attributeUnsearched("יש לכם חולצה לבנה?", [search("white shirt")])).toBe(false);
    expect(attributeUnsearched("יש במידה L?", [{ tool: "woocommerce.list_product_variations", args: { product_id: "1" } }])).toBe(false);
    expect(attributeUnsearched("יש במידה L?", [search("Oversized Cotton T-Shirt L")])).toBe(false);
  });
  it("no colour or size asked: not this rule", () => {
    expect(attributeUnsearched("אני מחפש מעיל", [])).toBe(false);
  });
  it("the absence is then false_absence", () => {
    expect(checkReplyStyle("כרגע אין אצלנו חולצה לבנה זמינה.", ctx({ attributeUnsearched: true })).map((v) => v.kind)).toContain("false_absence");
    expect(checkReplyStyle("כרגע אין אצלנו חולצה לבנה זמינה.", ctx({ attributeUnsearched: false })).map((v) => v.kind)).not.toContain("false_absence");
  });
  it("wired; a lookup turn (variations attached) is not unsearched", () => {
    expect(bot).toContain(`attributeUnsearched: !discoveryLookup && attributeUnsearched(opts.incomingMessage ?? "", toolCallLog),`);
  });
});

describe("\"מוצגות\" over no cards never survives", () => {
  const t = "כרגע יש כמה חולצות מכותנה. מוצגות כמה חלופות קרובות.";
  it("a gate issue at any length; the sentence goes", () => {
    expect(finalTextIssues(t, gate())).toContain("points_at_nothing");
    expect(dropBrokenSentences(t, gate())).toBe("כרגע יש כמה חולצות מכותנה.");
  });
  it("with cards it is fine", () => {
    expect(finalTextIssues(t, gate({ cardsShown: true }))).not.toContain("points_at_nothing");
  });
});

describe("short replies and loanwords", () => {
  it("three sentences up to 160 characters are not too long", () => {
    expect(checkReplyStyle("יש טרנץ' קל. יש גם מעיל צמר. איזה מתאים לך?", ctx({ incomingMessage: "אני מחפש מעיל" })).map((v) => v.kind)).not.toContain("too_long");
  });
  it("\"חולצת אוקספורד\" is Hebrew", () => {
    expect(transliteratedTitleWord("חולצת אוקספורד עם כפתורים", ["Oxford Button-Down Shirt"])).toBeNull();
  });
});
