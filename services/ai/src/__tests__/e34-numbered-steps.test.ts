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

describe("steps the model wrote inline go one per line (Demo dev 2026-11-10: \"השלבים הכלליים: 1. לנתק... 2. להסיר...\")", () => {
  it("split at 1., 2., 3. in order; a closing question on its own line", async () => {
    const { stepsOnLines } = await import("../services/reply-style-check.service");
    const out = stepsOnLines("השלבים להתקנה: 1. לנתק את המתח בלוח. 2. להסיר את המתג הישן. 3. לחבר את החוטים לפי הסימון. צריכים עזרה?");
    expect(out.split("\n")).toEqual(["השלבים להתקנה:", "1. לנתק את המתח בלוח.", "2. להסיר את המתג הישן.", "3. לחבר את החוטים לפי הסימון.", "צריכים עזרה?"]);
    expect(isStepList(out)).toBe(true);
  });
  it("a price, a version, a single number: untouched", async () => {
    const { stepsOnLines } = await import("../services/reply-style-check.service");
    for (const t of ["המתג עולה ₪205.5 במבצע.", "גרסה 2. זמינה עכשיו.", "יש 1. מתג אחד במלאי."]) expect(stepsOnLines(t)).toBe(t);
  });
  it("ai-bot splits before the style check and asks for the list on a steps turn", () => {
    const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "../services/ai-bot.service.ts"), "utf8");
    expect(src).toContain("if (stepsAsked(opts.incomingMessage)) replyText = stepsOnLines(replyText);\n      const violations = checkReplyStyle(replyText, styleCtx);");
    expect(src).toContain("הלקוח ביקש שלבים. ענו ברשימה ממוספרת קצרה");
  });
});
