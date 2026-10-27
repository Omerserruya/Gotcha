/**
 * Eval e12 on 74de71f6 (2026-10-26), the AA batch. The forced look (Z5) fired on
 * questions about the store and sent the catalogue as cards ("יש קוד קופון?" got
 * three products and no coupon); a budget was read off our own price; a bare
 * number was taken for USD; the prefix fix ran before the colours were Hebrew.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { storeQuestion, productQuestion } from "../services/woo-chat-turn.service";
import { parseBudget, budgetStatedBy } from "../services/discovery-integration.service";
import { checkReplyStyle, polishReply, closeAfterThanks, asksSomething } from "../services/reply-style-check.service";
import { askedColours } from "../services/reply-style-check.service";
import { asksSize } from "../services/woo-chat-turn.service";

const src = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf8");
const pq = (t: string) => productQuestion(t, askedColours(t).length, asksSize(t));

describe("AA1: a question about the store gets the answer, never a forced search or cards", () => {
  it.each(["יש קוד קופון?", "כמה עולה משלוח?", "מעל כמה חינם?", "ואם כבר כיבסתי?", "אפשר לשלם בביט?", "ובתשלומים?", "יש לכם חנות פיזית? אפשר לבוא למדוד?", "זה חשוב לי זה ליום הולדת"])("%s is about the store", (t) => {
    expect(storeQuestion(t)).toBe(true);
    expect(pq(t)).toBe(false);
  });
  it.each(["כמה זה?", "מגניב", "אוקיי סבבה"])("%s is no product question either", (t) => expect(pq(t)).toBe(false));
  it.each(["באפור יש?", "בשחור?", "מידה L", "ומה עם צעיף שיתאים?", "יש הנחה על הסוודר?"])("%s IS about a product", (t) => expect(pq(t)).toBe(true));
  it("the forced look is gated on a product question with no live options attached", () => {
    expect(src).toMatch(/wooTurn && round < 2 && !searchNudged && !lastOptionsAttached &&\s*productQuestion\(opts\.incomingMessage, askedColours\(opts\.incomingMessage\)\.length, asksSize\(opts\.incomingMessage\)\) &&/);
    expect(src).toContain("lastOptionsAttached = true;");
  });
  it("cards stay off on a store question", () => {
    // (+ an acknowledgement over cards already shown, urban-e24)
    expect(src).toContain('noCards: classifySituation(opts.incomingMessage ?? "", false) === "complaint" || storeQuestion(opts.incomingMessage) || ackOverCards,');
  });
});

describe("AA1: a budget is the customer's, in the store's currency", () => {
  it("a bare number is in the store's currency (A03: no \"prices are in ILS\" line)", () => {
    expect(parseBudget("400", "ILS")).toEqual({ target: 400, currency: "ILS" });
    expect(parseBudget({ target: 500 }, "ILS")).toEqual({ target: 500, currency: "ILS" });
    expect(parseBudget("100 USD", "ILS")).toEqual({ target: 100, currency: "USD" });
    expect(parseBudget("עד 300 דולר", "ILS")).toEqual({ target: 300, currency: "USD" });
    expect(parseBudget("200 ₪")).toEqual({ target: 200, currency: "ILS" });
  });
  it("L01: a budget read off our own price is not the customer's", () => {
    const customer = ["היי יש את המעיל טרנץ' במידה M?", "ובאיזה צבע?", "מעל כמה חינם?"];
    expect(budgetStatedBy(customer, "799 ILS")).toBe(false);
    expect(budgetStatedBy([...customer, "תקציב עד 500"], "500")).toBe(true);
    expect(budgetStatedBy(["משהו פחות מ400"], { target: 400 })).toBe(true);
    expect(budgetStatedBy(["עד 1,200 שקל"], "1200 ILS")).toBe(true);
  });
  it("the guard runs on what the extractor proposes", () => {
    const d = readFileSync(join(__dirname, "../services/discovery-integration.service.ts"), "utf8");
    expect(d).toMatch(/if \(f\.key !== "budget" \|\| budgetStatedBy\(texts, f\.value\)\) return true;/);
  });
  it("our own currency note has no masculine imperative", () => {
    const p = readFileSync(join(__dirname, "../services/product-search.service.ts"), "utf8");
    expect(p).not.toContain("שים לב: המחירים");
  });
});

describe("AA2: a thank-you gets a close, and a question is never answered with only a card", () => {
  it("A04: a close that thanks back is replaced", () => {
    expect(closeAfterThanks("מעולה, תודה.", "סבבה תודה", "he")).toBe("בכיף 🙂");
    expect(closeAfterThanks("בכיף 🙂", "סבבה תודה", "he")).toBe("בכיף 🙂");
  });
  it("F01: \"מידה M\" asks something, so cards alone re-ask the model", () => {
    expect(asksSomething("מידה M")).toBe(true);
    expect(asksSomething("בשחור")).toBe(true);
    expect(asksSomething("תראי לי")).toBe(false);
    expect(src).toContain('(!cardsShown || asksSomething(opts.incomingMessage ?? ""))');
  });
});

describe("AA3: gender leaks", () => {
  const ctx = { locale: "he" as const, isFirstReply: false, incomingMessage: "", productFactsAvailable: true, shopFloor: true, toolsOffered: [], customerClosing: false };
  it.each(["שים לב שהמחירים בשקלים.", "איזה סגנון מעדיף, מחוייט או רגוע?", "באיזה צבע את מחפשת?"])("%s is flagged", (t) => {
    expect(checkReplyStyle(t, ctx).map((v) => v.kind)).toContain("gendered_address");
  });
  it.each(["איזה סגנון מעדיפים?", "הבת שלך מחפשת שמלה?", "שימו לב לטבלת המידות."])("%s stays clean", (t) => {
    expect(checkReplyStyle(t, ctx).map((v) => v.kind)).not.toContain("gendered_address");
  });
  it("\"למגברים\" is a typo for לגברים", () => {
    expect(polishReply("מצאנו Wool Blend Overcoat למגברים.", { locale: "he" })).toBe("מצאנו Wool Blend Overcoat לגברים.");
  });
});

describe("AA4: a prefix attaches to a Hebrew colour, also after the English one is translated", () => {
  const p = (t: string) => polishReply(t, { locale: "he" });
  it.each([
    ["ב-Black, Sand ו-Grey", "בשחור, חול ואפור"],
    ["הוא קיים ב-שחור, חול ו-אפור Melange.", "הוא קיים בשחור, חול ואפור Melange."],
    ["זמינה ב‑Natural וב‑שחור.", "זמינה ב‑Natural ובשחור."],
    ["ב‑אקרו יש S.", "באקרו יש S."],
  ])("%s", (inp, out) => expect(p(inp)).toBe(out));
});

describe("AA5: no \"מייד\" promise", () => {
  it("\"נבדוק את זה מייד\" is a promise", () => {
    const ctx = { locale: "he" as const, isFirstReply: false, incomingMessage: "", productFactsAvailable: true, shopFloor: true, toolsOffered: ["woocommerce.get_order"], customerClosing: false };
    expect(checkReplyStyle("מצטערים, נבדוק את זה מייד. מה מספר ההזמנה?", ctx).map((v) => v.kind)).toContain("promise");
    expect(checkReplyStyle("מצטערים על זה. אפשר מספר הזמנה כדי שאבדוק?", ctx).map((v) => v.kind)).not.toContain("promise");
  });
});

describe("AB1: the Hebrew skill agrees with everything else", () => {
  const he = readFileSync(join(__dirname, "../prompts/hebrew.md"), "utf8");
  it("always neutral: no follow-their-form rule left", () => {
    expect(he).toMatch(/Address the customer neutrally, always/);
    expect(he).not.toMatch(/address them in it|אתה מחפש|את מחפשת"\*\*/);
  });
  it("no fixed idiom table and no sales ladder", () => {
    expect(he).not.toMatch(/על הכיפאק|פיקס|מתי נוח לך לקפוץ|בסיור/);
  });
  it("the mechanics the polish enforces are stated: prefixes, slashes, counts", () => {
    expect(he).toContain("בשחור");
    expect(he).toContain("נשארו אחרונות");
    expect(he).toMatch(/Lists without slashes/);
  });
  it("no wide dash and no maqaf", () => {
    expect(he).not.toMatch(/[–—־]/);
  });
});
