/**
 * Dev, 2026-10-26, conv cmvpbatca…: "ויש ג׳ינס?" got "כן, יש לנו ג'ינס
 * במקטגוריית מכנסיים, עולה ₪389. רוצה שאשלח פרטי המוצר עם תמונות ומידות?".
 * No tool ran that turn. The jeans are ₪349 and 389 appears nowhere: not in a
 * tool result, a card or the store's information. The draft had been flagged
 * for "לשלוח כרטיס", and the rewrite is never checked again.
 *
 *   - A price in the reply must come from something: the prompt (knowledge,
 *     policy), this turn's tool results, or the conversation and its cards.
 *   - The rewrite is checked for it: a made-up price is removed in code.
 *   - "לשלוח את פרטי המוצר ותמונות?" is an offer like "לבדוק?" (four times in
 *     this conversation): dropped from the end of a reply.
 *   - "במקטגוריית" is "בקטגוריית".
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkReplyStyle,
  statedPrices,
  ungroundedPrices,
  stripPrices,
  stripTrailingOffer,
  polishReply,
} from "../services/reply-style-check.service";

const SENT = "כן, יש לנו ג'ינס במקטגוריית מכנסיים, עולה ₪389. רוצה שאשלח פרטי המוצר עם תמונות ומידות?";
const GROUNDING = "Relaxed Straight Jeans - 349 ILS\nמשלוח חינם על הזמנות מעל ₪299 בתוך ישראל.";

const ctx = (o: any = {}) => ({
  locale: "he" as const, isFirstReply: false, incomingMessage: "ויש ג׳ינס?", productFactsAvailable: true,
  shopFloor: true, toolsOffered: ["woocommerce.list_products"], customerClosing: false, groundingText: GROUNDING, ...o,
});
const kinds = (text: string, o: any = {}) => checkReplyStyle(text, ctx(o)).map((v) => v.kind);

describe("the prices a reply states", () => {
  it("in every way they are written", () => {
    expect(statedPrices("עולה ₪389, או 349 ש״ח, או 1,290 ILS, או ₪ 99.00")).toEqual(["389", "349", "1290", "99"]);
    expect(statedPrices("3 צבעים ומידה M")).toEqual([]);
  });
  it("one nothing grounds is made up; one a card or the store's information shows is not", () => {
    expect(ungroundedPrices(SENT, GROUNDING)).toEqual(["389"]);
    expect(ungroundedPrices("הג'ינס עולה ₪349.", GROUNDING)).toEqual([]);
    expect(ungroundedPrices("משלוח חינם מעל ₪299.", GROUNDING)).toEqual([]);
    expect(ungroundedPrices("עולה 349.00 ₪", "price: 349")).toEqual([]);
  });
});

describe("the checker", () => {
  it("the reply that went out is caught", () => {
    expect(kinds(SENT)).toContain("ungrounded_price");
  });
  it("the true price is not", () => {
    expect(kinds("יש ג'ינס בגזרה ישרה ורחבה, ₪349.")).not.toContain("ungrounded_price");
  });
  it("only on a shop's floor, and only with grounding to compare against", () => {
    expect(kinds(SENT, { shopFloor: false })).not.toContain("ungrounded_price");
    expect(kinds(SENT, { groundingText: undefined })).not.toContain("ungrounded_price");
  });
});

describe("a made-up price removed in code, the rest kept", () => {
  it("the sentence that went out", () => {
    expect(stripPrices("כן, יש לנו ג'ינס בקטגוריית מכנסיים, עולה ₪389. אפשר לבחור מידה בכרטיס.", ["389"]))
      .toBe("כן, יש לנו ג'ינס בקטגוריית מכנסיים. אפשר לבחור מידה בכרטיס.");
  });
  it("other wordings, and a thousands comma", () => {
    expect(stripPrices("המעיל במחיר 389 ש״ח.", ["389"])).toBe("המעיל.");
    expect(stripPrices("זה עולה 1,290 ₪ ויש בשחור.", ["1290"])).toBe("זה ויש בשחור.");
  });
  it("a grounded price next to it stays", () => {
    expect(stripPrices("הג'ינס ₪349, המכנסיים ₪389.", ["389"])).toBe("הג'ינס ₪349, המכנסיים.");
  });
});

describe("an offer to send details or photos is an offer, not an answer", () => {
  for (const offer of [
    "רוצה שאשלח פרטי המוצר עם תמונות ומידות?",
    "לשלוח עבורך את פרטי המוצר ותמונות של הצבעים?",
    "לשלוח את פרטי המוצר ותמונות?",
    "לשלוח עבורך את פרטים ותמונות של הצבעים?",
  ]) {
    it(offer, () => {
      expect(stripTrailingOffer(`הצעיף עולה ₪159. ${offer}`)).toBe("הצעיף עולה ₪159.");
    });
  }
  it("a real question about sending is left alone", () => {
    const q = "ההזמנה מוכנה. לשלוח לכתובת בתל אביב או לאסוף?";
    expect(stripTrailingOffer(q)).toBe(q);
  });
});

describe("\"במקטגוריית\"", () => {
  it("is \"בקטגוריית\"; \"מקטגוריית\" (from) is left alone", () => {
    expect(polishReply("יש ג'ינס במקטגוריית מכנסיים.", { locale: "he" })).toContain("בקטגוריית מכנסיים");
    expect(polishReply("פריט מקטגוריית מכנסיים.", { locale: "he" })).toContain("מקטגוריית מכנסיים");
  });
});

describe("wired", () => {
  const src = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf8");
  it("the grounding never includes this turn's own drafts", () => {
    expect(src).toContain('...chatMessages.filter((m: any) => m.role !== "assistant")');
    expect(src).toContain("...priorOutbound.map((m: any) => String(m.body ?? \"\")),");
  });
  it("the rewrite is checked like the draft (finalizeRewrite, e17-rewrite-is-checked)", () => {
    expect(src).toContain("const final = finalizeRewrite(replyText, styleCtx);");
  });
});
