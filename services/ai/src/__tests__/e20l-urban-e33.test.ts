/**
 * urban-e33 and the cart replay on fb22fc9d (2026-10-28).
 *
 *   Replay T4 "אוקי ויש מעיל לגברים ?": searched {"query":"Jacket","audience":"men"}
 *   (the audit's args). The person in the CURRENT message wins; the two
 *   jackets it showed are for men (Quilted Liner: Men; Denim Trucker: Men + Women).
 *   U3: "טרנץ' קל מקטון" is cotton in Hebrew letters.
 *   "איזה צבע היא מעדיפה?" is about her, not a gendered address to the customer.
 */
import { describe, it, expect } from "vitest";
import { conversationAudience } from "../services/woo-chat-turn.service";
import { checkReplyStyle, polishReply } from "../services/reply-style-check.service";

const REPLAY = [
  { direction: "INBOUND", body: "היי" },
  { direction: "OUTBOUND", body: "היי! מה מחפשים היום בחנות?" },
  { direction: "INBOUND", body: "מחפש מתנה לבת זוגג שלי" },
  { direction: "OUTBOUND", body: "איזה סוג פריט מתאים, מעיל, סוודר או תיק?" },
  { direction: "INBOUND", body: "אקססורי חמוד" },
  { direction: "OUTBOUND", body: "תיק קטן מעור ותיק בד קנבס." },
];

describe("replay T4: the person in the current message wins", () => {
  it("\"מעיל לגברים\" after \"מתנה לבת זוגג שלי\" searches for men", () => {
    expect(conversationAudience(REPLAY, "אוקי ויש מעיל לגברים ?")).toBe("men");
    // Already in the history as well (the history may hold the incoming message).
    expect(conversationAudience([...REPLAY, { direction: "INBOUND", body: "אוקי ויש מעיל לגברים ?" }], "אוקי ויש מעיל לגברים ?")).toBe("men");
  });
  it("a message naming no one keeps the last person named", () => {
    expect(conversationAudience(REPLAY, "ויש משהו בשחור?")).toBe("women");
  });
});

describe("U3: cotton in Hebrew letters", () => {
  const p = (t: string) => polishReply(t, { locale: "he", incomingMessage: "מעיל" });
  it.each([
    ["טרנץ' קל מקטון, מראה קלאסי.", "טרנץ' קל מכותנה, מראה קלאסי."],
    ["טרנץ' קל מקוטון.", "טרנץ' קל מכותנה."],
    ["חולצת קוטון לבנה.", "חולצת כותנה לבנה."],
  ])("%s", (inp, out) => expect(p(inp)).toBe(out));
  it("קטן stays small", () => expect(p("תיק קטן מעור.")).toBe("תיק קטן מעור."));
});

describe("a question about someone else is not addressed to the customer (urban-e33)", () => {
  const ctx = { locale: "he" as const, isFirstReply: false, incomingMessage: "מתנה לבת זוג", productFactsAvailable: true, shopFloor: true, toolsOffered: [], customerClosing: false } as any;
  const kinds = (t: string) => checkReplyStyle(t, ctx).map((v) => v.kind);
  it.each(["איזה צבע היא מעדיפה?", "איזו מידה הבת שלך צריכה?", "איזה סגנון בת הזוג מעדיפה?"])("%s", (t) => expect(kinds(t)).not.toContain("gendered_address"));
  it.each(["איזה צבע מעדיפה?", "איזה סגנון אתה מחפש?", "מה מעדיף, צמר או כותנה?"])("still caught: %s", (t) => expect(kinds(t)).toContain("gendered_address"));
});
