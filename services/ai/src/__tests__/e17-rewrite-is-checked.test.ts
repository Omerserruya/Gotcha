/**
 * The rewrite is checked like the draft (2026-10-26).
 *
 * The checker regenerates a flagged draft ONCE, and the rewrite used to go out
 * unchecked. The same hole showed up three times in one day: store titles in
 * the sentence, "לא נמצאה חולצה לבנה במלאי" (the shirt was in stock) and a
 * made-up "₪389" (the jeans are ₪349). Each got its own patch. This is the
 * general one: after the rewrite, anything UNTRUE left is fixed in code. Style
 * leftovers (length, a second question) may pass.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  finalizeRewrite,
  cannotArrangeLine,
  notFoundByNameLine,
  lookItUpLine,
  checkReplyStyle,
} from "../services/reply-style-check.service";

const GROUNDING = "Relaxed Straight Jeans - 349 ILS\nמשלוח חינם על הזמנות מעל ₪299 בתוך ישראל.";
const ctx = (o: any = {}) => ({
  locale: "he" as const, isFirstReply: false, incomingMessage: "ויש ג׳ינס?", productFactsAvailable: true,
  shopFloor: true, toolsOffered: ["woocommerce.list_products", "send_product_card"], toolsCalled: [] as string[],
  customerClosing: false, groundingText: GROUNDING, ...o,
});
const fin = (text: string, o: any = {}) => finalizeRewrite(text, ctx(o));

describe("a true rewrite goes out as it is", () => {
  it("nothing to fix", () => {
    const t = "יש ג'ינס בגזרה ישרה ורחבה, ₪349. אפשר לבחור מידה בכרטיס.";
    expect(fin(t)).toEqual({ text: t, fixed: [] });
  });
  it("style leftovers pass: two questions is not untrue", () => {
    const t = "יש בשחור ובכחול. איזה צבע? ואיזו מידה?";
    expect(checkReplyStyle(t, ctx()).map((v) => v.kind)).toContain("two_questions");
    expect(fin(t).text).toBe(t);
  });
});

describe("anything untrue is fixed in code", () => {
  it("a made-up price is removed, the rest kept (the ₪389)", () => {
    expect(fin("כן, יש לנו ג'ינס בקטגוריית מכנסיים, עולה ₪389. אפשר לבחור מידה בכרטיס.")).toEqual({
      text: "כן, יש לנו ג'ינס בקטגוריית מכנסיים. אפשר לבחור מידה בכרטיס.",
      fixed: ["price_removed"],
    });
  });
  it("\"out of stock\" after an empty title search: the not-found line", () => {
    expect(fin("כרגע לא נמצאה חולצה לבנה במלאי.", { searchesAllEmpty: true }).text).toBe(notFoundByNameLine("he"));
  });
  it("saying a detail was recorded when nothing recorded it: the can't-arrange line", () => {
    expect(fin("רשמנו את המספר, נעדכן כשיחזור.").text).toBe(cannotArrangeLine("he"));
  });
  it("a promise no tool backs: its sentence dropped, the answer kept", () => {
    const out = fin("יש את המעיל במידה M. אחזור אליך כשיגיע צבע נוסף.");
    expect(out.text).toBe("יש את המעיל במידה M.");
    expect(out.fixed).toContain("promise_dropped");
  });
  it("a size with no product facts at all: dropped; nothing left, the look-it-up line", () => {
    expect(fin("יש מידה M.", { productFactsAvailable: false }).text).toBe(lookItUpLine("he"));
  });
  it("a sentence left with almost nothing goes with its price", () => {
    expect(fin("הג'ינס ₪389. אפשר לבחור מידה בכרטיס.").text).toBe("אפשר לבחור מידה בכרטיס.");
  });
  it("nothing true left: the look-it-up line, never a stub like \"הג'ינס.\"", () => {
    expect(fin("הג'ינס ₪389. לשלוח את פרטי המוצר ותמונות?").text).toBe(lookItUpLine("he"));
  });
  it("English too", () => {
    expect(finalizeRewrite("The jeans are 389 ILS. They run true to size.", { ...ctx(), locale: "en" }).text)
      .toBe("They run true to size.");
  });
});

describe("never sends something untrue", () => {
  const cases: Array<[string, any]> = [
    ["כן, יש לנו ג'ינס, עולה ₪389.", {}],
    ["כרגע אין במלאי.", { searchesAllEmpty: true }],
    ["רשמתי את הטלפון שלך.", {}],
    ["אשמור לך את המידה עד מחר.", {}],
    ["מידה M וגם מידה L, ₪120.", { productFactsAvailable: false }],
  ];
  for (const [text, o] of cases) {
    it(text, () => {
      const out = fin(text, o).text;
      const untrue = checkReplyStyle(out, ctx(o)).filter((v) =>
        ["ungrounded_price", "ungrounded_attribute", "false_absence", "phantom_action", "promise"].includes(v.kind));
      expect(untrue).toEqual([]);
      expect(out.trim().length).toBeGreaterThan(0);
    });
  }
});

describe("wired after the one rewrite", () => {
  const src = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf8");
  it("finalizeRewrite runs on the rewrite, and the per-case patches it replaced are gone", () => {
    expect(src).toContain("const final = finalizeRewrite(replyText, styleCtx);");
    expect(src).not.toContain("const stillPhantom");
  });
});
