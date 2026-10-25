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

describe("★ e5 S6", () => {
  it("another script inside a Hebrew reply", () => {
    expect(kinds("אם تريد אפשר לראות עוד")).toContain("foreign_script");
    expect(kinds("יש Chunky Cardigan ב-M")).not.toContain("foreign_script");
  });
  it("her own question, word for word, again", () => {
    expect(kinds("מה מספר ההזמנה?", { previousReplies: ["אוי, מבאס. מה מספר ההזמנה?"] })).toContain("repeated_question");
    expect(kinds("מה מספר ההזמנה?", { previousReplies: ["איזו מידה?"] })).not.toContain("repeated_question");
  });
  it.each(["עשה רושם שזה מתאים", "חקרתי במלאי וזיהיתי", "טוב שאלה"])("odd phrasing: %s", (t) => {
    expect(kinds(t)).toContain("banned_phrase");
  });
  it("semicolons become commas, an HTML entity is left alone", async () => {
    const { polishReply } = await import("../services/reply-style-check.service");
    expect(polishReply("יש ב-S ו-M; L אזל", { locale: "he" })).toBe("יש ב-S ו-M, L אזל");
    expect(polishReply("Jackets &amp; Coats", { locale: "en" })).toBe("Jackets &amp; Coats");
  });
  it("a 'בכיף 🙂' tacked onto a non-thanks reply is removed", async () => {
    const { stripStrayClose } = await import("../services/reply-style-check.service");
    expect(stripStrayClose("יש במידה M בשחור. בכיף 🙂", "יש בשחור?")).toBe("יש במידה M בשחור.");
    expect(stripStrayClose("בכיף 🙂", "תודה!")).toBe("בכיף 🙂");
  });
});

describe("★ e6 regressions", () => {
  it("R-a: 'יש גרביים?' is not a goodbye", async () => {
    const { customerIsClosing } = await import("../services/objectives");
    expect(customerIsClosing("יש גרביים?")).toBe(false);
    expect(customerIsClosing("ביי!")).toBe(true);
    expect(customerIsClosing("תודה, יום טוב")).toBe(true);
  });
  it("R-c: two words with a slash are a list, not a gender form", () => {
    expect(kinds("משלוח לאירופה/בריטניה לוקח 5-8 ימים")).not.toContain("slash_form");
    expect(kinds("תרצה/י לראות?")).toContain("slash_form");
    expect(kinds("אתה/את מעדיף/ה כותנה?")).toContain("slash_form");
  });
  it("R-b, R-c: the regen corrective is a system message that names the language", () => {
    const { readFileSync } = require("node:fs");
    const { join } = require("node:path");
    const src: string = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf8");
    const at = src.indexOf("buildStyleCorrective(violations, replyLocale) +");
    expect(src.slice(at - 200, at)).toContain('role: "system"');
    expect(src.slice(at, at + 300)).toContain('Write the reply in ${replyLocale === "he" ? "Hebrew" : "English"}');
  });
});

describe("★ e6: no phantom add-to-cart", () => {
  it.each(["נוסיף אותו לסל עבורך?", "רוצים שאוסיף לך את המידה M לעגלה?"])("%s", (t) => {
    expect(kinds(t)).toContain("promise");
  });
  it("pointing at the card's button is fine", () => {
    expect(kinds("אפשר להוסיף לסל ישר מהכרטיס")).not.toContain("promise");
  });
});

describe("★ e7 T4: no repeated or narrating parentheticals", () => {
  it.each([
    ["Heavyweight Hoodie במלאי (Heavyweight Hoodie)", "Heavyweight Hoodie במלאי"],
    ["יש בצבע בז' (בז')", "יש בצבע בז'"],
    ["יש בצבע אפור פחם (אפור פחם) במידה M", "יש בצבע אפור פחם במידה M"],
    ["יש צ'ינו בזית (ראוי למטה: Chino Pants)", "יש צ'ינו בזית"],
  ])("%s", async (input, want) => {
    const { polishReply } = await import("../services/reply-style-check.service");
    expect(polishReply(input, { locale: "he", productTitles: ["Heavyweight Hoodie", "Chino Pants"] })).toBe(want);
  });
  it("a parenthetical that adds something stays", async () => {
    const { polishReply } = await import("../services/reply-style-check.service");
    expect(polishReply("משלוח רגיל (2-4 ימי עסקים)", { locale: "he" })).toBe("משלוח רגיל (2-4 ימי עסקים)");
  });
  it("narrating the card, and saving a place, are caught", () => {
    expect(kinds("כן, ראו למטה את הכרטיס")).toContain("banned_phrase");
    expect(kinds("או לשמור מקום לאיסוף?")).toContain("promise");
  });
});

describe("★ e7 T3: cards the model sent itself, and no text", () => {
  it("a short line, never the failure fallback", async () => {
    const { deliverableReply } = await import("../services/ai-bot.service");
    expect(deliverableReply({ safeReply: null, pendingEscalation: false, awaitingApproval: false, toolCallLog: [], locale: "he", cardsShown: true })).toBe("בבקשה 🙂");
  });
});

describe("★ voice runs: the brand's close is not tacked onto a non-thanks reply", () => {
  it.each([
    ["באיזו מידה לחפש? בכיף אהובה ❤️", "באיזו מידה לחפש?"],
    ["יש בשחור ובאפור. בכיף אהובה ❤️ יום מצוין!", "יש בשחור ובאפור."],
    ["₪79. בשמחה.", "₪79."],
  ])("%s", async (input, want) => {
    const { stripStrayClose } = await import("../services/reply-style-check.service");
    expect(stripStrayClose(input, "יש גרביים?")).toBe(want);
  });
  it("after a thank-you the close stays; 'כן, בשמחה' as an answer stays", async () => {
    const { stripStrayClose } = await import("../services/reply-style-check.service");
    expect(stripStrayClose("בכיף אהובה ❤️", "תודה!")).toBe("בכיף אהובה ❤️");
    expect(stripStrayClose("כן, בשמחה", "אפשר להחליף מידה?")).toBe("כן, בשמחה");
  });
  it("V-b: 'לא בטוח' from an ungendered employee", () => {
    expect(kinds("לא בטוח מאיזה מהן יש גם אדום")).toContain("self_gender");
    expect(kinds("לא בטוחים איזה מהן")).not.toContain("self_gender");
  });
});

describe("★ e8", () => {
  it("U4: imperatives to an unknown customer, not ordinary words", () => {
    for (const t of ["ראה למטה את הכרטיס", "שלח שם המוצר", "תאר בקצרה מה קרה", "ותראה אותו מטה", "הוסף לסל מהכרטיס"]) {
      expect(kinds(t), t).toContain("gendered_address");
    }
    for (const t of ["יש לנו מבחר גדול", "המעיל מראה טוב", "הנה הקישור"]) expect(kinds(t), t).not.toContain("gendered_address");
  });
  it("U7: a one-line question gets two sentences at most", () => {
    expect(kinds("משלוח בארץ 2-4 ימים ב-₪29. איסוף מהסטודיו בחינם. לחו\"ל 5-8 ימים.", { incomingMessage: "כמה עולה משלוח?" })).toContain("too_long");
    expect(kinds("משלוח בארץ 2-4 ימי עסקים ב-₪29.", { incomingMessage: "כמה עולה משלוח?" })).not.toContain("too_long");
  });
  it("L-2: 'מעביר את השיחה' from an ungendered employee", () => {
    expect(kinds("מעביר את השיחה לנציג אנושי", { handedOff: true })).toContain("self_gender");
  });
  it("L-3: no question after a plain acknowledgement", () => {
    expect(kinds("רוצים שאשלח שוב את כרטיס הסוודר?", { incomingMessage: "מגניב" })).toContain("push_after_ack");
    expect(kinds("מעולה 🙂", { incomingMessage: "אוקיי סבבה" })).not.toContain("push_after_ack");
  });
  it("U1/D02: a trailing offer is removed in code, the answer stays", async () => {
    const { stripTrailingOffer } = await import("../services/reply-style-check.service");
    expect(stripTrailingOffer("ה-Chunky Cardigan עולה ₪529. לבדוק אם יש גם בחום?")).toBe("ה-Chunky Cardigan עולה ₪529.");
    expect(stripTrailingOffer("לבדוק אם יש גם בחום?")).toBe("לבדוק אם יש גם בחום?");
  });
  it("U6: a translated colour and its raw form in brackets print once", async () => {
    const { polishReply } = await import("../services/reply-style-check.service");
    expect(polishReply("יש בצבע אפור פחם (Charcoal)", { locale: "he" })).toBe("יש בצבע אפור פחם");
  });
  it("U3: asked colours map to the store's option words", async () => {
    const { askedColours, variationsOfferColour } = await import("../services/reply-style-check.service");
    expect(askedColours("מכנסיים שחורים?")).toEqual(["black"]);
    expect(askedColours("יש בצבע בז'?")).toEqual(["beige", "sand", "oat"]);
    expect(askedColours("כמה זה עולה?")).toEqual([]);
    const chino = [{ attributes: [{ name: "Colour", option: "Olive" }] }, { attributes: [{ name: "Colour", option: "Sand" }] }];
    expect(variationsOfferColour(chino, ["black"])).toBe(false);
    expect(variationsOfferColour([{ attributes: [{ option: "Grey Melange" }] }], ["grey", "gray"])).toBe(true);
  });
});

describe("★ e9", () => {
  it("W3: never offer the card", () => {
    expect(kinds("רוצים שאציג אותו ככרטיס מוצר?")).toContain("banned_phrase");
  });
  it("W5: phantom pickup and checkout help", () => {
    expect(kinds("רוצים שאשלח לאיסוף בסטודיו?")).toContain("promise");
    expect(kinds("רוצים שאעזור להשלים את ההזמנה?")).toContain("promise");
  });
  it("W5: collecting a phone or a time for a callback, with no handoff", () => {
    expect(kinds("קיבלנו את 0521234567. מתי נוח לשיחה?")).toContain("promise");
    expect(kinds("קיבלנו את 0521234567. מתי נוח לשיחה?", { handedOff: true })).not.toContain("promise");
    expect(kinds("מתי נוח לך לשיחה? ציין שעה")).toContain("gendered_address");
  });
  it("W7: 'שמח לשמוע', the 'רואים למטה' tic, formal 'יש לשלוח'", () => {
    expect(kinds("שמח לשמוע!")).toContain("self_gender");
    expect(kinds("כן, רואים למטה")).toContain("banned_phrase");
    expect(kinds("יש לשלוח את מספר ההזמנה")).toContain("banned_phrase");
  });
});

describe("★ e9 W1: the numbered list is never the text on a card channel", () => {
  it("the fallback list is skipped where cards render", () => {
    const { readFileSync } = require("node:fs");
    const { join } = require("node:path");
    const src: string = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf8");
    expect(src).toContain("if (delivery.useTextFallback && channelSupportsCards) {");
    expect(src).toContain('NOT: { messageType: { contains: "product" } },');
  });
});
