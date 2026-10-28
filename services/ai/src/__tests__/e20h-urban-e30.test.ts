/** urban-e30 (dev 2026-10-27): the last small items before e31. */
import { describe, it, expect } from "vitest";
import { checkReplyStyle, echoOpener, fixInCode, polishReply, finalTextIssues, type StyleCheckContext, type FinalGateContext } from "../services/reply-style-check.service";

const ctx = (o: Partial<StyleCheckContext> = {}): StyleCheckContext => ({
  locale: "he", isFirstReply: false, incomingMessage: "מה עם משלוח?", productFactsAvailable: true, shopFloor: true,
  toolsOffered: [], customerClosing: false, ...o,
});
const kinds = (t: string, o: Partial<StyleCheckContext> = {}) => checkReplyStyle(t, ctx(o)).map((v) => v.kind);

describe("1) \"the demo\" on a shop's floor is our source", () => {
  it("\"זמן הגעה בדמו\", \"בגרסת הדמו\"", () => {
    expect(kinds("זמן הגעה בדמו: הכנה עד יומיים ומשלוח 3 עד 5 ימי עסקים.")).toContain("source_leak");
    expect(kinds("בגרסת הדמו המשלוח חינם מעל ₪299.")).toContain("source_leak");
  });
  it("a sales employee's demo meeting is not", () => {
    expect(kinds("אפשר לקבוע דמו קצר מחר?", { shopFloor: false })).not.toContain("source_leak");
    expect(kinds("נראה את זה בדמו מחר.", { shopFloor: false })).not.toContain("source_leak");
  });
});

describe("2) a participle to the customer anywhere in a question", () => {
  it("\"יותר מתאים לשכבות או מעדיף משהו חם?\"", () => {
    expect(kinds("יותר מתאים לשכבות או מעדיף משהו חם?")).toContain("gendered_address");
    expect(finalTextIssues("טרנץ' קל או מעיל צמר. יותר מתאים לשכבות או מעדיף משהו חם?", { ...ctx({ shopFloor: false }), cardsShown: true, productTitles: [] } as FinalGateContext)).toContain("gendered");
  });
  it("not after a subject, and not outside a question", () => {
    expect(kinds("אני מעדיף להמליץ על המעיל.")).not.toContain("gendered_address");
    expect(kinds("האם היא מעדיפה צעיף או כובע?")).not.toContain("gendered_address");
  });
});

describe("3) the customer's word with a word of praise as the opener", () => {
  it("\"מעיל טוב,\" / \"מעיל מצוין,\" after \"אני מחפש מעיל\"", () => {
    expect(echoOpener("מעיל טוב, יש טרנץ' קל ומעיל צמר.", "אני מחפש מעיל")).toBe("מעיל טוב,");
    const d = "מעיל מצוין, יש טרנץ' קל ומעיל צמר.";
    expect(fixInCode(d, checkReplyStyle(d, ctx({ incomingMessage: "אני מחפש מעיל" })))).toBe("יש טרנץ' קל ומעיל צמר.");
  });
  it("a description that starts with the word is content, not an echo", () => {
    expect(echoOpener("מעיל צמר ארוך, קלאסי וחם.", "אני מחפש מעיל")).toBeNull();
  });
});

describe("4) Hebrew", () => {
  it("\"שני אופציות\" → \"שתי אופציות\"", () => {
    expect(polishReply("יש שני אופציות ושני אפשרויות.", { locale: "he" })).toBe("יש שתי אופציות ושתי אפשרויות.");
    expect(polishReply("יש שני מעילים.", { locale: "he" })).toBe("יש שני מעילים.");
  });
  it("\"להקפאה\" is banned", () => {
    expect(kinds("מעיל צמר חם להקפאה.")).toContain("banned_phrase");
  });
});
