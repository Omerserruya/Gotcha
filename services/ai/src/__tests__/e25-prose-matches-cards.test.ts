/**
 * P5 (Tehila cmw26crzp 13:51): the text described three scarves and one card
 * ("אנה") went out. When the text speaks of more products than were carded,
 * it is rewritten once to describe only the carded ones.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { proseOutnumbersCards } from "../services/reply-style-check.service";

describe("does the text describe more than the cards?", () => {
  it("three described, one card (her case)", () => {
    expect(proseOutnumbersCards("כמה מטפחות חגיגיות: מטפחת מלבנית מבד שיפון, מטפחת קלילה בהדפסים, ודגם משולש נוח לקשירה.", 0, 1)).toBe(true);
    expect(proseOutnumbersCards("There are a few options here.", 0, 1)).toBe(true);
  });
  it("named three, two went out", () => {
    expect(proseOutnumbersCards("…", 3, 2)).toBe(true);
  });
  it("matches: left as it is", () => {
    expect(proseOutnumbersCards("מטפחת אנה, בד קל וצבעים חגיגיים.", 0, 1)).toBe(false);
    expect(proseOutnumbersCards("שלוש אפשרויות", 3, 3)).toBe(false);
    expect(proseOutnumbersCards("כמה אפשרויות", 0, 3)).toBe(false);
    expect(proseOutnumbersCards("anything", 2, 0)).toBe(false);
  });
});

describe("the bot rewrites once to the carded products", () => {
  const src = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf8");
  it("after staging, from the staged record's own products, before the delivery decision", () => {
    expect(src).toContain("if (replyText?.trim() && carded.length && proseOutnumbersCards(replyText, namedKeys, carded.length)) {");
    expect(src).toContain("(((productTurn?.staged ?? []).at(-1) as any)?.metadata?.commerce?.products ?? [])");
    expect(src.indexOf("proseOutnumbersCards(replyText, namedKeys")).toBeLessThan(src.indexOf("const delivery = decideDelivery(recoPlan, outcome);"));
    expect(src).toMatch(/Rewrite it to describe only [\s\S]{0,400}no SHOW line/);
  });
  it("a failed rewrite keeps the reply; an abort still aborts", () => {
    expect(src).toContain("cards-match rewrite failed (kept)");
    expect(src).toMatch(/if \(err\?\.name === "AbortError"\) throw err;\n\s+console\.warn\(`\[ai-bot\] cards-match rewrite failed/);
  });
});
