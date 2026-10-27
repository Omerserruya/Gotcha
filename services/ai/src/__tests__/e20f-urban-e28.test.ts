/** urban-e28 (dev 2026-10-27): the must-fix items before any prod build. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkReplyStyle, finalTextIssues, transliteratedTitleWord, finalizeRewrite, type FinalGateContext, type StyleCheckContext } from "../services/reply-style-check.service";
import { extractionCapMs } from "../services/judgement-cap";
import { namesProduct } from "../services/woo-chat-turn.service";

const ctx = (o: Partial<StyleCheckContext> = {}): StyleCheckContext => ({
  locale: "he", isFirstReply: false, incomingMessage: "מה עם משלוח?", productFactsAvailable: true, shopFloor: true,
  toolsOffered: [], customerClosing: false, ...o,
});
const gate = (o: Partial<FinalGateContext> = {}): FinalGateContext => ({ ...ctx({ shopFloor: false }), cardsShown: false, productTitles: [], ...o });
const bot = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf8");

describe("1) never name our sources to the customer", () => {
  const leak = "יש שתי גרסאות במסמכים: דף Shipping & Returns מציין משלוח סטנדרטי ₪29 ובבסיס הדמו מופיע ₪25, ומשלוח חינם בהזמנות מעל ₪299.";
  it("caught as untrue, and at the final gate", () => {
    expect(checkReplyStyle(leak, ctx()).map((v) => v.kind)).toContain("source_leak");
    expect(finalTextIssues(leak, gate())).toContain("source_leak");
  });
  it("a range with no source passes", () => {
    const ok = "משלוח רגיל עולה בין ₪25 ל־₪29, וחינם בהזמנות מעל ₪299.";
    expect(checkReplyStyle(ok, ctx()).map((v) => v.kind)).not.toContain("source_leak");
  });
  it("a rewrite that still names a source loses that sentence", () => {
    const out = finalizeRewrite("משלוח חינם מעל ₪299. לפי המסמכים שלנו המחיר הוא ₪29.", ctx({ groundingText: "₪29 ₪299" }));
    expect(out.text).toBe("משלוח חינם מעל ₪299.");
  });
  it("booking a demo is not a source", () => {
    expect(checkReplyStyle("אפשר לקבוע דמו קצר מחר?", ctx()).map((v) => v.kind)).not.toContain("source_leak");
  });
  it("the knowledge block tells the model so", () => {
    const pb = readFileSync(join(__dirname, "../services/prompt-builder.service.ts"), "utf8");
    expect(pb).toContain("Never tell the customer where information comes from");
  });
});

describe("2) a product answer with no card", () => {
  it("a store title in the Hebrew sentence with no card under it", () => {
    expect(finalTextIssues("מעולה, אצלנו יש Lambswool Scarf במחיר מבצע של ₪159.", gate())).toContain("title");
  });
  it("\"היא אוהבת צעיפים\" names a kind of product (plural), so the turn is told to search", () => {
    expect(namesProduct("היא אוהבת צעיפים")).toBe(true);
    expect(bot).toContain("The customer named a kind of product. Search for it now with woocommerce.list_products");
  });
});

describe("3) the audience carries into the next predicted search", () => {
  it("P2's call is in the tool log before the turn audit the next turn reads", () => {
    expect(bot.indexOf("P2's hit or miss")).toBeLessThan(bot.indexOf("// Audit - full BehaviorState + tool calls."));
    expect(bot.indexOf("P2's hit or miss")).toBeGreaterThan(bot.indexOf("for (let round = 0; round < (choiceShortCircuit ? 0 : 3); round++) {"));
  });
});

describe("4) a title word in Hebrew letters", () => {
  const titles = ["Cropped Hoodie", "Poplin Overshirt", "Ribbed Wool Beanie", "Leather Belt", "Cotton Trench Coat", "Long Sleeve Waffle Tee", "Crewneck Sweatshirt", "Relaxed Linen Shirt"];
  for (const [t, w] of [["קרופד הודי, נוח וספורטיבי", "קרופד"], ["וכובע צמר ריב חם", "ריב"], ["חולצת אוברשירט קלה", "אוברשירט"]] as const) {
    it(t, () => expect(transliteratedTitleWord(t, titles)).toBe(w));
  }
  for (const t of ["הצעיף בולט בצבע", "שניהם זמינים כעת", "מתאים לשילוב עם שכבות", "חולצת טי בטקסטורת וופל", "סווטשירט עם צווארון", "החזרות ושירות תיקונים", "יש לנו כרגע מבצעים"]) {
    it(`not: ${t}`, () => expect(transliteratedTitleWord(t, titles)).toBeNull());
  }
  it("goes to the rewrite at the final gate", () => {
    expect(finalTextIssues("קרופד הודי, נוח וספורטיבי.", gate({ cardsShown: true, productTitles: titles }))).toContain("transliteration");
  });
});

describe("the glued dash and the extraction's cap", () => {
  it("a wide dash between two words is a comma at model_done", () => {
    expect(bot).toContain(`if (replyText) replyText = replyText.replace(/(\\p{L})\\s*[\\u2013\\u2014]\\s*(\\p{L})/gu, "$1, $2");`);
  });
  it("the extraction waits up to 9s where the side cap is on", () => {
    expect(extractionCapMs({ NODE_ENV: "development" } as any)).toBe(9000);
    expect(extractionCapMs({ NODE_ENV: "production" } as any)).toBeNull();
    expect(extractionCapMs({ NODE_ENV: "development", AI_EXTRACTION_CAP_MS: "12000" } as any)).toBe(12000);
  });
});
