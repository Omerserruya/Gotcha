/**
 * Eval e11 on 17e01f74 (2026-10-26), the Z batch: no details gathered for what
 * no tool does (Omer: "לא מבטיחה מה שלא יכולה"), always-neutral address, no
 * slashes or unit counts in Hebrew text, one push at most, look instead of
 * asking to look, a defect is a complaint, and "מידה L" is about the product
 * the last search found, not the last English title in our text.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { checkReplyStyle, phantomActions, polishReply, stripTrailingPush, asksToShowInstead } from "../services/reply-style-check.service";
import { pickLastProduct, productsFromSearch } from "../services/woo-chat-turn.service";
import { classifySituation } from "../services/historical-intelligence/brand-voice";
import { deliverableReply, cannotArrangeLine } from "../services/ai-bot.service";

const WOO_TOOLS = ["escalate_to_human", "woocommerce.get_order", "woocommerce.list_orders", "woocommerce.list_products", "woocommerce.list_product_variations", "schedule_followup"];
const ctx = (over: Partial<Parameters<typeof checkReplyStyle>[1]> = {}) => ({
  locale: "he" as const, isFirstReply: false, incomingMessage: "", productFactsAvailable: true, shopFloor: true,
  toolsOffered: WOO_TOOLS, customerClosing: false, ...over,
});
const kinds = (draft: string, over = {}) => checkReplyStyle(draft, ctx(over)).map((v) => v.kind);

describe("Z1: no details gathered for what no tool does", () => {
  it.each([
    ["A05 a restock alert", "כרגע אזל ואין תאריך חזרה. רוצים שנודיע ברגע שיחזור, באימייל או טלפון?", "מתי יחזרו למלאי?"],
    ["C04 an order change", "אפשר לבדוק את הסטטוס, ואז נשנה את המידה.", "הזמנתי אתמול ורוצה לשנות מידה"],
    ["C06 measurements for custom work", "אין לנו אישור להתאמה אישית. כמה ס\"מ להאריך את המעיל?", "אפשר להזמין את המעיל באורך יותר ארוך? בהתאמה אישית"],
  ])("%s is flagged", (_n, draft, incoming) => {
    expect(phantomActions(draft, { toolsOffered: WOO_TOOLS, incomingMessage: incoming }).length).toBeGreaterThan(0);
    expect(kinds(draft, { incomingMessage: incoming })).toContain("phantom_action");
  });
  it("C02: a phone and a time for a callback is a promise, \"שיחזור\" included", () => {
    expect(kinds("אפשר לקבל את מספר הטלפון שנעביר לצוות שיחזור אליך?")).toContain("promise");
    expect(kinds("רשמנו את המספר 0521234567. מתי נוח לקבל שיחה?")).toContain("promise");
  });
  it("an order number IS right with an order lookup, and flagged without one", () => {
    expect(phantomActions("מה מספר ההזמנה?", { toolsOffered: WOO_TOOLS, incomingMessage: "ההזמנה לא הגיעה" })).toEqual([]);
    expect(phantomActions("מה מספר ההזמנה?", { toolsOffered: ["escalate_to_human"], incomingMessage: "ההזמנה לא הגיעה" })).toEqual(["מספר ההזמנה"]);
  });
  it("an order-editing tool licenses the change; a plain size answer is not custom work", () => {
    expect(phantomActions("נשנה את המידה ל-L.", { toolsOffered: [...WOO_TOOLS, "woocommerce.update_order"], incomingMessage: "" })).toEqual([]);
    expect(phantomActions("ה-M מתאים לגובה 170 ס\"מ.", { toolsOffered: WOO_TOOLS, incomingMessage: "איזו מידה?" })).toEqual([]);
  });
  it("the plain line is neutral, says it can't be arranged, and offers the team in the chat", () => {
    const he = cannotArrangeLine("he");
    expect(he).toMatch(/אין לנו אפשרות לסדר מכאן/);
    expect(he).toMatch(/לצוות כאן בצ'אט/);
    expect(checkReplyStyle(he, ctx()).filter((v) => v.kind !== "too_long")).toEqual([]);
  });
  it("the prompt states the rule in the truth core and the shop floor", () => {
    const src = readFileSync(join(__dirname, "../services/prompt-builder.service.ts"), "utf8");
    expect(src).toMatch(/7c\. \*\*Never gather details for something no tool does/);
    expect(src).toMatch(/Changing or cancelling an order already placed .* needs a person/);
    expect(src).toMatch(/Never offer to let them know when it is back/);
  });
});

describe("C04: an order that does not exist is said, not \"לא הבנתי\"", () => {
  const miss = { tool: "woocommerce.get_order", args: { order_id: "1043" }, result: '{"ok":false,"failure":"errored","reason":"woocommerce_404: {\\"code\\":\\"woocommerce_rest_shop_order_invalid_id\\"}"}' };
  it("an empty turn after a 404 lookup names the number and asks again", () => {
    const out = deliverableReply({ safeReply: "", pendingEscalation: false, awaitingApproval: false, toolCallLog: [miss], locale: "he" });
    expect(out).toBe("לא מצאנו הזמנה עם המספר 1043. אפשר לבדוק את המספר ולשלוח שוב?");
  });
  it("the model's own words still win", () => {
    expect(deliverableReply({ safeReply: "לא מצאנו את ההזמנה.", pendingEscalation: false, awaitingApproval: false, toolCallLog: [miss], locale: "he" })).toBe("לא מצאנו את ההזמנה.");
  });
});

describe("Z2: a defect in what arrived is a complaint (no cards)", () => {
  it.each(["קיבלתי חולצה עם חור", "יש כתם על המכנסיים", "הסוודר נפרם אחרי כביסה", "the shirt arrived with a hole"])("%s", (t) => {
    expect(classifySituation(t, false)).toBe("complaint");
  });
  it("shopping words stay shopping", () => {
    expect(classifySituation("יש חולצה מכופתרת?", false)).not.toBe("complaint");
  });
});

describe("Z3: always neutral, even when the customer genders themselves", () => {
  const fem = { customerForm: { form: "feminine", confidence: "explicit" } };
  const masc = { customerForm: { form: "masculine", confidence: "explicit" } };
  it.each([
    ["F03", "בעמוד המוצר תוכל לבחור צבע ומידה.", masc],
    ["F03b", "איזו מידה תרצה?", masc],
    ["B04", "מעדיפה שאשלח כמה פריטים מסריגים?", fem],
    ["F01", "מעדיף מראה מסודר או רפוי?", masc],
    ["F01b", "איזה צבע אתה מחפש?", masc],
    ["B01", "היי, מחפש מתנה בבגד או משהו אחר?", masc],
    ["E01", "Heavyweight Hoodie מתאים אם את רוצה משהו חם יותר.", fem],
  ])("%s is flagged", (_id, draft, form) => {
    expect(kinds(draft, form)).toContain("gendered_address");
  });
  it.each(["אפשר לבחור צבע ומידה בעמוד המוצר.", "מחפשים משהו לחורף?", "איזו מידה מתאימה?", "לבחור את המידה בכרטיס.", "הבת שלך מחפשת שמלה?"])("neutral stays clean: %s", (draft) => {
    expect(kinds(draft)).not.toContain("gendered_address");
  });
  it("the prompt and the state note say neutral always", () => {
    const pb = readFileSync(join(__dirname, "../services/prompt-builder.service.ts"), "utf8");
    expect(pb).toMatch(/always neutral\*\* - in a gendered language, address the customer NEUTRALLY in every reply/);
    expect(pb).toMatch(/grammaticalAddressPromptBlock\(\s*null,/);
    const hist = readFileSync(join(__dirname, "../services/conversation-history.service.ts"), "utf8");
    expect(hist).not.toMatch(/address them that way/);
  });
});

describe("Z4 + Z6 + Z7: deterministic Hebrew touches", () => {
  const p = (t: string, incoming = "") => polishReply(t, { locale: "he", incomingMessage: incoming });
  it("slash lists become words", () => {
    expect(p("ממליצים על חולצות/סווטשירטים רכים.")).toBe("ממליצים על חולצות או סווטשירטים רכים.");
    expect(p("זה קשור להזמנה/למוצר/למשלוח?")).toBe("זה קשור להזמנה, למוצר או למשלוח?");
    expect(p("לבחור S/XL בנייבי?")).toBe("לבחור S או XL בנייבי?");
    expect(p("וה-XS/M/L בשחור.")).toBe("וה-XS, M או L בשחור.");
    expect(p("אקספרס בינלאומי (EU/UK/NA) עולה ₪89.")).toBe("אקספרס בינלאומי (EU, UK או NA) עולה ₪89.");
  });
  it("dates, links, ו/או and gender endings are left alone", () => {
    expect(p("בתוקף עד 30/11.")).toBe("בתוקף עד 30/11.");
    expect(p("ראו https://demo-store.28042000.xyz/product/a/b")).toBe("ראו https://demo-store.28042000.xyz/product/a/b");
    expect(p("החלפה ו/או החזר.")).toBe("החלפה ו/או החזר.");
    expect(p("מה שתחליט/י.")).toBe("מה שתחליט/י.");
  });
  it("no unit counts unless asked; three or fewer are the last ones", () => {
    expect(p("יש S בצבע בז', נשארו 13 יחידות.")).toBe("יש S בצבע בז'.");
    expect(p("יש XS בשחור (7 יחידות במלאי) וב-Natural (10 במלאי).")).toBe("יש XS בשחור וב-Natural.");
    expect(p("ה-Canvas Tote ב-Natural במלאי (22 יח') במחיר ₪129.")).toBe("ה-Canvas Tote ב-Natural במלאי במחיר ₪129.");
    expect(p("יש L בנייבי (2 יח').")).toBe("יש L בנייבי (נשארו אחרונות).");
    expect(p("נשארו 13 יחידות.", "כמה יחידות נשארו?")).toBe("נשארו 13 יחידות.");
  });
  it("a Hebrew word after a prefix attaches; Latin keeps its no-break hyphen", () => {
    // "Oat" is a colour, and Hebrew since urban-e32; a Latin word that is none keeps the hyphen.
    expect(p("זמין ב‑חום ו‑Melange.")).toBe("זמין בחום ו‑Melange.");
    expect(p("זמין ב‑חום ו‑Oat.")).toBe("זמין בחום ובז' בהיר.");
    expect(p("שחור, אפור Melange ו‑חול.")).toBe("שחור, אפור Melange וחול.");
  });
  it("E05: narrating the cards is removed, the answer stays", () => {
    expect(polishReply("יש, שמתי עבורך תוצאות חיות למטה. ראו: Cotton Trench Coat", { locale: "he", productTitles: ["Cotton Trench Coat"] })).toBe("יש");
    expect(p("יש Cotton Trench Coat במידה S.")).toBe("יש Cotton Trench Coat במידה S.");
  });
  it("Off-White is one colour; unworn is נלבש", () => {
    expect(p("בצבעים Off-White ואפור פחם.")).toBe("בצבעים אוף וייט ואפור פחם.");
    expect(p("הפריט חייב להיות לא נשען ולא נשטף.")).toBe("הפריט חייב להיות לא נלבש ולא נשטף.");
  });
});

describe("Z5: one push at most, never after a factual answer; look instead of asking", () => {
  const earlier: string[] = [];
  it("a push after a question is removed", () => {
    expect(stripTrailingPush("הצעיף האפור עולה ₪159 וכרגע במלאי. להמשיך עם הצעיף האפור?", { incomingMessage: "כמה עולה?", earlierReplies: earlier }))
      .toBe("הצעיף האפור עולה ₪159 וכרגע במלאי.");
    expect(stripTrailingPush("בזית במידה L, עולה ₪319. רוצה שאפתח את כרטיס המוצר כדי להוסיף לסל?", { incomingMessage: "מידה L אחי", earlierReplies: ["להוסיף לסל מהכרטיס?"] }))
      .toBe("בזית במידה L, עולה ₪319.");
  });
  it("the first push, after something that is not a question, stays", () => {
    const r = "מעולה. אפשר להוסיף לסל ישר מהכרטיס, להמשיך?";
    expect(stripTrailingPush(r, { incomingMessage: "סבבה אני לוקחת", earlierReplies: ["יש S בבז'."] })).toBe(r);
  });
  it("a reply that is only the push is left for the checker", () => {
    expect(stripTrailingPush("להמשיך עם הצעיף?", { incomingMessage: "כמה עולה?", earlierReplies: [] })).toBe("להמשיך עם הצעיף?");
  });
  it.each([
    "אפשר לבדוק ולהציג צעיפים באפור שמתאימים לסוודר. להראות עכשיו צעיפים באפור?",
    "יש לנו כובעי צמר, אבל כדי לאשר אם יש שחור צריך לבדוק במלאי. להראות עכשיו כובעי צמר בשחור?",
  ])("asking to show is caught: %s", (t) => expect(asksToShowInstead(t)).toBe(true));
  it("an answer is not an ask", () => expect(asksToShowInstead("יש צעיף באפור, Lambswool Scarf, ₪159.")).toBe(false));
  it("the loop searches instead, once, only on a Woo turn with nothing searched", () => {
    const src = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf8");
    expect(src).toMatch(/wooTurn && round < 2 && !searchNudged &&[\s\S]{0,400}!toolCallLog\.some\(\(t\) => PRODUCT_SEARCH_TOOL\.test\(t\.tool\)\) &&\s*asksToShowInstead\(response\.content\)/);
  });
});

describe("Z8: \"מידה L\" is about the product the last search found", () => {
  const sweater = { productId: "243", title: "Cotton Cable Sweater" };
  const at = (hms: string) => new Date(`2026-10-26T${hms}Z`);
  it("L01: the sweater search is newer than the cardigan named in our text", () => {
    const mention = { title: "Chunky Cardigan", at: at("06:48:25") };
    expect(pickLastProduct(mention, { at: at("06:49:42"), products: [sweater] })).toEqual(sweater);
  });
  it("a product named in the same turn as its search keeps its id", () => {
    const mention = { title: "Ribbed Wool Beanie", at: at("06:54:56") };
    expect(pickLastProduct(mention, { at: at("06:54:55"), products: [{ productId: "429", title: "Ribbed Wool Beanie" }, { productId: "1", title: "Other" }] }))
      .toEqual({ productId: "429", title: "Ribbed Wool Beanie" });
  });
  it("a search with several results and none named is no answer: the model looks", () => {
    expect(pickLastProduct(null, { at: at("06:55:39"), products: [{ productId: "425", title: "Leather Crossbody Bag" }, { productId: "421", title: "Canvas Tote Bag" }] })).toBeNull();
  });
  it("an older search loses to a newer mention", () => {
    const mention = { productId: "364", title: "Cotton Trench Coat", at: at("06:58:46") };
    expect(pickLastProduct(mention, { at: at("06:49:42"), products: [sweater] })).toEqual(mention);
  });
  it("search results parse; a failed lookup is none", () => {
    expect(productsFromSearch('{"ok":true,"result":[{"id":243,"name":"Cotton Cable Sweater"}]}')).toEqual([sweater]);
    expect(productsFromSearch('{"ok":true,"result":{"id":243,"name":"Cotton Cable Sweater"}}')).toEqual([sweater]);
    expect(productsFromSearch('{"ok":false}')).toEqual([]);
    expect(productsFromSearch("not json")).toEqual([]);
  });
});
