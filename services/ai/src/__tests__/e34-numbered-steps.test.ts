/**
 * Omer 2026-11-10 (Demo: "מה השלבים להתקנה של מתג לתריס?"): installation and
 * how-to answers go out as numbered steps, one per line. The length rule
 * flattened them into one paragraph. A short numbered list answering a steps
 * question now passes the style check and the final gate, and keeps its lines;
 * every other answer keeps the no-list, short-prose rule.
 */
import { describe, it, expect } from "vitest";
import { checkReplyStyle, finalTextIssues, normalizePunctuation, polishReply, stepsAsked, isStepList } from "../services/reply-style-check.service";
import { humanizeReply } from "../services/reply-style";

const STEPS = [
  "אלה השלבים להתקנת מתג לתריס:",
  "1. נתקו את החשמל בלוח לפני שמתחילים.",
  "2. פרקו את המתג הקיים וסמנו את החוטים.",
  "3. חברו את החוטים למתג החדש לפי הסימון.",
  "4. הבריגו את המתג לקופסה וסגרו את המסגרת.",
  "5. החזירו את החשמל ושייכו את המתג באפליקציה.",
  "צריכים עזרה בשלב מסוים?",
].join("\n");

const style = (incomingMessage: string) => ({ locale: "he" as const, isFirstReply: false, incomingMessage, productFactsAvailable: false, shopFloor: true, toolsOffered: [] }) as any;
const gate = (incomingMessage: string) => ({ ...style(incomingMessage), cardsShown: false }) as any;

describe("a steps question", () => {
  it("is recognised; a shopping or price question is not", () => {
    for (const t of ["מה השלבים להתקנה של מתג לתריס?", "איך מחברים את המתג?", "יש הוראות התקנה?", "how do I install the switch?", "what are the setup steps?"]) expect(stepsAsked(t), t).toBe(true);
    for (const t of ["כמה עולה המתג?", "אילו מתגים יש לכם?", "do you have a white mat?"]) expect(stepsAsked(t), t).toBe(false);
  });
  it("a short numbered list passes the style check and the final gate", () => {
    expect(isStepList(STEPS)).toBe(true);
    expect(checkReplyStyle(STEPS, style("מה השלבים להתקנה של מתג לתריס?")).map((v) => v.kind)).not.toContain("too_long");
    expect(finalTextIssues(STEPS, gate("מה השלבים להתקנה של מתג לתריס?"))).toEqual([]);
  });
  it("its lines survive polish, punctuation and humanise: one step per line", () => {
    const out = normalizePunctuation(humanizeReply(polishReply(STEPS, { locale: "he", incomingMessage: "מה השלבים להתקנה של מתג לתריס?" })) ?? "");
    const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
    expect(lines.filter((l) => /^\d\.\s/.test(l))).toHaveLength(5);
    expect(lines[1]).toMatch(/^1\. /);
    expect(lines[5]).toMatch(/^5\. /);
  });
});

describe("everything else keeps the rule", () => {
  it("the same list for a shopping question is still too long", () => {
    expect(checkReplyStyle(STEPS, style("אילו מתגים יש לכם?")).map((v) => v.kind)).toContain("too_long");
  });
  it("more than 6 steps, steps out of order, or a long step: not a step list", () => {
    const seven = ["השלבים:", ...[1, 2, 3, 4, 5, 6, 7].map((n) => `${n}. שלב קצר.`)].join("\n");
    expect(isStepList(seven)).toBe(false);
    expect(isStepList("1. אחד.\n3. שלוש.")).toBe(false);
    expect(isStepList(`1. ${"מילה ".repeat(40)}\n2. שתיים.`)).toBe(false);
    expect(isStepList("פסקה אחת בלי שלבים בכלל.")).toBe(false);
  });
});
