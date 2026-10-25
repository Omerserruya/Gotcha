/**
 * The reply checker (2026-10-25, P3), pinned with the eval's own failures.
 */
import { describe, it, expect } from "vitest";
import { checkReplyStyle, buildStyleCorrective, polishReply, type StyleCheckContext } from "../services/reply-style-check.service";

const ctx = (o: Partial<StyleCheckContext> = {}): StyleCheckContext => ({
  locale: "he", isFirstReply: false, incomingMessage: "יש ב-M?", customerForm: null,
  employeeGender: null, employeeName: "Noa", productFactsAvailable: true, shopFloor: true,
  toolsOffered: ["woocommerce.list_products"], customerClosing: false, ...o,
});
const kinds = (t: string, o?: Partial<StyleCheckContext>) => checkReplyStyle(t, ctx(o)).map((v) => v.kind);

describe("★ the eval's failures are caught", () => {
  it("G02/E05 slash forms", () => {
    expect(kinds("תרצה/י לראות עוד?")).toContain("slash_form");
    expect(kinds("אתה/את מעדיף/ה כותנה?")).toContain("slash_form");
  });
  it("masculine and feminine imperatives to a customer of unknown gender; not once their form is known", () => {
    expect(kinds("שלח לי את מספר ההזמנה")).toContain("gendered_address");
    expect(kinds("תבחרי מידה ונבדוק")).toContain("gendered_address");
    expect(kinds("שלח לי את מספר ההזמנה", { customerForm: { form: "masculine", confidence: "explicit" } })).not.toContain("gendered_address");
  });
  it("R4: a greeting or a self-intro after the first reply", () => {
    expect(kinds("היי! יש ב-M")).toContain("greeting_after_first");
    expect(kinds("היי! יש ב-M", { isFirstReply: true })).not.toContain("greeting_after_first");
    expect(kinds("היי, אני נועה מצוות שירות הלקוחות, יש ב-M", { isFirstReply: true })).toContain("self_intro");
  });
  it("R3: her own gender, unset (plural only) or set", () => {
    expect(kinds("אני לא יכול לבדוק את זה")).toContain("self_gender");
    expect(kinds("מצטערת על זה")).toContain("self_gender");
    expect(kinds("אני בודק רגע", { employeeGender: "feminine" })).toContain("self_gender");
    expect(kinds("אני בודקת רגע", { employeeGender: "feminine" })).not.toContain("self_gender");
    expect(kinds("נבדוק רגע")).not.toContain("self_gender");
  });
  it("\"נועא\": her name misspelled", () => {
    expect(kinds("זו נועא, יש ב-M")).toContain("own_name");
  });
  it("R6: reserving and calling back are promises no tool keeps", () => {
    expect(kinds("רוצה שנשמור לך את המידה?")).toContain("promise");
    expect(kinds("אבדוק מול הסטודיו ואחזור אליך")).toContain("promise");
    expect(kinds("נציג יחזור אליך", { toolsOffered: [] })).toContain("promise");
    // Offering the tool is not enough: only a handoff that happened this turn.
    expect(kinds("נציג יחזור אליך", { toolsOffered: ["escalate_to_human"] })).toContain("promise");
    expect(kinds("נציג יחזור אליך", { toolsOffered: ["escalate_to_human"], handedOff: true })).not.toContain("promise");
  });
  it("Noa's invented colours: an attribute with no product result, only on a shop floor", () => {
    expect(kinds("יש אותו בשחור ובנייבי", { productFactsAvailable: false })).toContain("ungrounded_attribute");
    expect(kinds("עולה ₪389", { productFactsAvailable: false })).toContain("ungrounded_attribute");
    expect(kinds("הפגישה זמינה מחר", { productFactsAvailable: false, shopFloor: false })).not.toContain("ungrounded_attribute");
  });
  it("filler, two questions, a question after a thank-you, a policy dump", () => {
    expect(kinds("בהחלט! יש ב-M")).toContain("banned_phrase");
    expect(kinds("איזו מידה? ואיזה צבע?")).toContain("two_questions");
    expect(kinds("בכיף! רוצה שאשלח קישור?", { customerClosing: true, incomingMessage: "תודה רבה!" })).toContain("question_after_thanks");
    expect(kinds("משלוח בארץ 2-4 ימי עסקים. איסוף מהסטודיו למחרת. משלוח לחו\"ל 5-8 ימים. מעל ₪299 חינם. החזרות 30 יום.")).toContain("too_long");
  });
});

describe("★ a natural reply passes", () => {
  it.each([
    "יש ב-M, בשחור ובלבן",
    "Chunky Cardigan עולה ₪529",
    "בכיף 🙂",
    "את הצבעים הזמינים אין לי אפשרות לאשר כרגע. אפשר לבדוק את זה מול הצוות.",
    "איזו מידה מחפשים?",
  ])("%s", (t) => {
    expect(checkReplyStyle(t, ctx({ customerClosing: t === "בכיף 🙂" }))).toEqual([]);
  });
});

describe("the corrective and the polish", () => {
  it("names each violation once, with what was found", () => {
    const c = buildStyleCorrective(checkReplyStyle("היי! תרצה/י לראות?", ctx()), "he");
    expect(c).toContain('No slash forms');
    expect(c).toContain('(found: "תרצה/י")');
    expect(c).toContain("Do not greet");
  });
  it("English colours become Hebrew outside a title; ILS becomes ₪", () => {
    expect(polishReply("יש את Black Linen Shirt בצבע Beige ב-529 ILS", { locale: "he", productTitles: ["Black Linen Shirt"] }))
      .toBe("יש את Black Linen Shirt בצבע בז' ב-₪529");
    expect(polishReply("in Black", { locale: "en" })).toBe("in Black");
  });
});

describe("no false alarms on ordinary shop words", () => {
  it.each(["יש לנו מבחר גדול של מעילים", "המעיל נבחר להיות הנמכר ביותר"])("%s", (t) => {
    expect(kinds(t)).not.toContain("gendered_address");
  });
});

describe("★ wired into the turn", () => {
  const { readFileSync } = require("node:fs");
  const { join } = require("node:path");
  const src: string = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf8");
  it("one regeneration, after the other gates and before the product rendering", () => {
    const check = src.indexOf("const violations = checkReplyStyle(replyText, {");
    expect(check).toBeGreaterThan(src.indexOf("── Booking fail-safe gate"));
    expect(check).toBeLessThan(src.indexOf("const emptySearch = !!productEnvelope"));
    expect(src.match(/metadata: \{ type: "ai_bot_style_regen"/g)).toHaveLength(1);
  });
  it("a bare thank-you closes, and the sales push stands down on a shop floor", async () => {
    const { customerIsClosing } = await import("../services/objectives");
    expect(customerIsClosing("תודה רבה!")).toBe(true);
    expect(customerIsClosing("תודה, ויש גם במידה L?")).toBe(false);
    expect(src).toContain("!isShopFloor({ toolFunctionNames, company: companyContext ?? undefined }) &&");
  });
});

describe("★ after a bare thank-you: only a short warm close", () => {
  it("E04: the regenerated push is replaced", async () => {
    const { closeAfterThanks } = await import("../services/reply-style-check.service");
    expect(closeAfterThanks("אפשר לשלוח שוב את כרטיס המוצר של Oversized Cotton T-Shirt כדי להוסיף אותו לסל. בכיף 🙂", "תודה רבה!", "he")).toBe("בכיף 🙂");
    expect(closeAfterThanks("רוצה שאשלח קישור?", "תודה, ביי", "he")).toBe("בשמחה, יום טוב!");
    expect(closeAfterThanks("שמחים לעזור, ומה עוד?", "להתראות", "he")).toBe("בשמחה, יום טוב!");
  });
  it("in the customer's language: English, Arabic", async () => {
    const { closeAfterThanks } = await import("../services/reply-style-check.service");
    expect(closeAfterThanks("Would you like me to send the link again?", "thanks!", "en")).toBe("Anytime 🙂");
    expect(closeAfterThanks("هل تريد رابط المنتج مرة أخرى؟", "شكرا جزيلا", "en")).toBe("العفو 🙂");
  });

  it("the model's own short close stays, register and all", async () => {
    const { closeAfterThanks } = await import("../services/reply-style-check.service");
    expect(closeAfterThanks("בכיף אהובה ❤️", "תודה רבה!", "he")).toBe("בכיף אהובה ❤️");
  });

  it("a short close stays; a thank-you with a question is not a close", async () => {
    const { closeAfterThanks } = await import("../services/reply-style-check.service");
    expect(closeAfterThanks("בשמחה! יום נהדר 🙂", "תודה רבה!", "he")).toBe("בשמחה! יום נהדר 🙂");
    expect(closeAfterThanks("יש גם ב-L, בשחור.", "תודה! ויש ב-L?", "he")).toBe("יש גם ב-L, בשחור.");
  });
  it("the corrective says: only a short close, no offer, no product", () => {
    expect(buildStyleCorrective([{ kind: "question_after_thanks", match: "x" }], "he")).toContain("No offer, no product, no next step.");
  });
});

describe("★ e5 S1: an empty search is never 'we don't have it'", () => {
  it.each(["אין לנו כרגע מעילים במלאי", "אין לנו קפוצ'ונים", "לא נמצאו תיקים", "השמלה אזלה"])("%s", (t) => {
    expect(kinds(t, { searchesAllEmpty: true })).toContain("false_absence");
  });
  it("allowed when a search did find the product out of stock, and 'לא מצאתי' is fine", () => {
    expect(kinds("השמלה אזלה במידה M", { searchesAllEmpty: false })).not.toContain("false_absence");
    expect(kinds("לא מצאתי מעיל בשם הזה, אפשר לחפש לפי צבע?", { searchesAllEmpty: true })).not.toContain("false_absence");
  });
});

describe("★ e5 S4: past-tense phantom actions", () => {
  it.each(["שמרנו את המידה S ונשלח את כרטיס המוצר", "שריינתי לך את הזוג", "רשמתי לנציג שיחזור אליך", "העברנו לצוות הסטודיו"])("%s", (t) => {
    expect(kinds(t)).toContain("promise");
  });
  it("a real handoff this turn may be stated", () => {
    expect(kinds("העברנו לצוות, הם ימשיכו מכאן", { handedOff: true })).not.toContain("promise");
  });
});

describe("★ e5 S3: ending on an offer to check", () => {
  it.each(["במידה M יש בבז'. לבדוק זמינות בצבע אחר?", "יש ב-S. רוצה שאבדוק אם יש בחום במידה M?", "אפשר לבדוק את זה?"])("%s", (t) => {
    expect(kinds(t)).toContain("offer_to_check");
  });
  it("a real question to the customer is fine", () => {
    expect(kinds("איזו מידה מחפשים?")).not.toContain("offer_to_check");
    expect(kinds("יש ב-S ו-M בבז'.")).not.toContain("offer_to_check");
  });
});
