/**
 * A size question is a lookup, not a support issue.
 *
 * Live: "יש את The Minimal Snowboard במידה 159?" was handled by the
 * RESOLVE_ISSUE objective, which is instructed to ask only what it needs to
 * diagnose - so it asked which colour the customer meant. Every product in
 * this catalogue has a single `Default Title` variant, so that question had no
 * answer and the customer was interrogated about options that do not exist.
 *
 * The detector must be narrow in one specific direction: ordinary browsing
 * ("אני מחפש סנובורד למתחיל") must stay with product discovery, where a
 * recommendation conversation is the right behaviour.
 */
import { describe, it, expect } from "vitest";
import {
  detectVariantIntent,
  buildVariantIntentDirective,
  detectCouponIntent,
  buildCouponUnsupportedDirective,
  detectOrderNoteIntent,
  buildOrderNoteDirective,
} from "../services/product-intent.service";

describe("detecting a variant question", () => {
  it("fires on the live regression", () => {
    const i = detectVariantIntent("יש את The Minimal Snowboard במידה 159?");
    expect(i.isVariantQuestion).toBe(true);
    expect(i.attributeToken).toBe("159");
  });

  it("fires on colour and SKU questions", () => {
    expect(detectVariantIntent("יש את זה בצבע שחור?").isVariantQuestion).toBe(true);
    expect(detectVariantIntent("do you have SKU LIQ-1 in stock?").isVariantQuestion).toBe(true);
  });

  it("fires on plain availability of a named option", () => {
    expect(detectVariantIntent("המידה 159 במלאי?").isVariantQuestion).toBe(true);
  });

  it("does NOT fire on open browsing - that belongs to discovery", () => {
    expect(detectVariantIntent("אני מחפש סנובורד אול מאונטיין למתחיל").isVariantQuestion).toBe(false);
    expect(detectVariantIntent("יש סנובורד עד 800 שקל?").isVariantQuestion).toBe(false);
  });

  it("does NOT fire on order or support messages", () => {
    expect(detectVariantIntent("איפה המשלוח שלי?").isVariantQuestion).toBe(false);
    expect(detectVariantIntent("אני רוצה לבטל את הזמנה 1010").isVariantQuestion).toBe(false);
    expect(detectVariantIntent("").isVariantQuestion).toBe(false);
  });
});

describe("the directive", () => {
  const d = buildVariantIntentDirective({ isVariantQuestion: true, attributeToken: "159" }, "he");

  it("sends the model to the catalogue with a name, not a search", () => {
    expect(d).toMatch(/variant_information/);
    expect(d).toMatch(/product_name/);
    expect(d).toMatch(/do NOT need a product search/i);
  });

  it("pre-empts the dead-end clarifying question", () => {
    expect(d).toMatch(/Do NOT ask which version/i);
    expect(d).toMatch(/has_variant_options is false/);
  });

  it("forbids the 'checking now, I'll get back to you' non-answer", () => {
    expect(d).toMatch(/checking now/i);
    expect(d).toMatch(/answer/i);
  });

  it("carries the value the customer named", () => {
    expect(d).toContain("159");
  });
});

/**
 * Coupons are out of scope for customer conversations (product decision).
 *
 * The live failure was one reply that offered to create a coupon, promised to
 * pass the details to a team, and speculated about booking a meeting. The tools
 * are now ASSIST-only so the model has none - and a model with no tool
 * improvises unless it is told what the answer is.
 */
describe("coupon requests", () => {
  it.each([
    "יש קופון?",
    "תן לי הנחה",
    "תיצור לי קופון",
    "תוסיף קופון להזמנה",
    "הקוד ABC תקף?",
    "אפשר לקבל קופון כפיצוי?",
    "יש לכם קוד הנחה?",
    "do you have a promo code?",
  ])("detects %s", (text) => {
    expect(detectCouponIntent(text)).toBe(true);
  });

  it("does not fire on ordinary product or order talk", () => {
    expect(detectCouponIntent("אני רוצה לבטל את הזמנה 1011")).toBe(false);
    expect(detectCouponIntent("יש את זה במידה 159?")).toBe(false);
    expect(detectCouponIntent("")).toBe(false);
  });

  it("the directive forbids every observed improvisation", () => {
    const d = buildCouponUnsupportedDirective();
    expect(d).toMatch(/NOT SUPPORTED/);
    expect(d).toMatch(/Do NOT offer to create/i);
    // no pivot to money back - a discount question is not a refund request
    expect(d).toMatch(/Do NOT offer a refund/i);
    // a discount question is not an incident
    expect(d).toMatch(/Do NOT transfer the conversation/i);
    expect(d).toMatch(/Do NOT promise/i);
    expect(d).toContain("לא ניתן להפיק, לבדוק או להוסיף קופון");
  });
});

/**
 * "Write this on my order."
 *
 * The model never called the tool. Asked to record a callback request on #1011
 * it said "ביצעתי את הבקשה", and once that was stripped it said "בקשתך עודכנה
 * בהזמנה" - twice claiming a write while Shopify showed note: null, tags: "".
 */
describe("order note requests", () => {
  it.each([
    "תכתבו בהזמנה שאני מבקש שיחזרו אליי",
    "תוסיפו הערה שהמוצר הגיע פגום",
    "תתעדו שחסר פריט",
    "תרשמו בהזמנה 1011 שאני מבקש שיחזרו אליי לפני המשלוח",
    "please add a note on the order",
  ])("detects %s", (t) => expect(detectOrderNoteIntent(t)).toBe(true));

  it("does not fire on unrelated requests", () => {
    expect(detectOrderNoteIntent("אני רוצה לבטל את הזמנה 1011")).toBe(false);
    expect(detectOrderNoteIntent("איפה המשלוח שלי?")).toBe(false);
  });

  it("requires the tool to run before the claim", () => {
    const d = buildOrderNoteDirective();
    expect(d).toMatch(/add_order_note/);
    expect(d).toMatch(/THIS turn/);
    expect(d).toMatch(/Only after it returns successfully/i);
  });

  it("states plainly that a note is not a team notification", () => {
    const d = buildOrderNoteDirective();
    expect(d).toMatch(/does not notify anyone/i);
    expect(d).toMatch(/do NOT say or imply that a team/i);
    expect(d).toMatch(/separate handoff/i);
  });
});
