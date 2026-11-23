/**
 * Dev 2026-11-23, GOTCHA Demo 2 (conversation c1fa07ab06b2e64fd07995fe9), in the middle of a booking: the draft
 * "כדי שהנציגה תוכל לחזור אלייך ולתאם, מה השם ומספר הטלפון?" became the safe line "אפשר לפרט קצת יותר מה מחפשים?".
 * "תוכל" there is the agent's verb ("she will be able"), never an address; "אלייך" is the gendered word, and its neutral
 * spelling is "אליך". A style problem alone never costs a turn its answer. Neutral address stays the rule (Omer).
 */
import { describe, it, expect } from "vitest";
import { checkReplyStyle, finalTextIssues } from "../services/reply-style-check.service";
import { neutralSecondPerson, genderedOnly, afterFinalRewrite } from "../services/reply-engine/gates";

const DRAFT = "כדי שהנציגה תוכל לחזור אלייך ולתאם, מה השם ומספר הטלפון?";
const ctx: any = { locale: "he", isFirstReply: false, incomingMessage: "אני רוצה לקבוע פגישה", customerForm: null, employeeGender: null, employeeName: "Noa", productFactsAvailable: true, shopFloor: true, toolsOffered: [], customerClosing: false };
const gendered = (t: string) => checkReplyStyle(t, ctx).filter((v: any) => v.kind === "gendered_address").map((v: any) => v.match);

describe("★ a verb with a subject of its own is no address; \"אלייך\" is", () => {
  it("the Demo 2 draft: only \"אלייך\" is gendered, and its neutral form keeps the agent's verb", () => {
    expect(gendered(DRAFT)).toEqual(["אלייך"]);
    expect(neutralSecondPerson(DRAFT)).toBe("כדי שהנציגה תוכל לחזור אליך ולתאם, מה השם ומספר הטלפון?");
    expect(gendered(neutralSecondPerson(DRAFT))).toEqual([]);
  });
  it("a third-person subject: a definite noun or a pronoun", () => {
    for (const t of ["הצוות יוכל לחזור אליך מחר.", "היא תוכל לבחור מידה.", "השליחה תוכל להשאיר את החבילה ליד הדלת."]) expect(gendered(t), t).toEqual([]);
  });
  it("still an address: no subject, or a question word that is no subject", () => {
    expect(gendered("תוכל לשלוח תמונה?")).toEqual(["תוכל"]);
    expect(gendered("האם תוכל לשלוח את מספר ההזמנה?")).toEqual(["תוכל"]);
    expect(neutralSecondPerson("האם תוכל לשלוח את מספר ההזמנה?")).toBe("האם תוכלו לשלוח את מספר ההזמנה?");
    expect(gendered("שלחי לי תמונה.")).toEqual(["שלחי"]);
    // A definite noun inside a phrase is no subject (eval e11 F03).
    expect(gendered("בעמוד המוצר תוכל לבחור צבע ומידה.")).toEqual(["תוכל"]);
    expect(gendered("נחזור עלייך בהמשך.").length).toBe(1);
  });
});

describe("★ the legacy final gate: a style problem alone never becomes the safe line", () => {
  it("a gendered address alone is fixed in code (the Demo 2 turn keeps its booking question)", () => {
    const issues = finalTextIssues(DRAFT, ctx);
    expect(genderedOnly(issues)).toBe(true);
    const neutral = neutralSecondPerson(DRAFT);
    expect(finalTextIssues(neutral, ctx)).toEqual([]);
  });
  it("after the one rewrite: clean, style only, the draft's style only, broken", () => {
    expect(afterFinalRewrite(["gendered"], [], "כדי לתאם, מה השם ומספר הטלפון?")).toBe("candidate");
    expect(afterFinalRewrite(["gendered"], ["gendered"], "כדי שהנציגה תוכל לחזור אלייך, מה השם?")).toBe("neutral_candidate");
    expect(afterFinalRewrite(["gendered"], ["dangling"], "מה ה")).toBe("neutral_draft");
    expect(afterFinalRewrite(["calque"], ["dangling"], "")).toBe("neutral_draft");
    expect(afterFinalRewrite(["dangling"], ["dangling"], "מה ה")).toBe("safe");
    expect(afterFinalRewrite(["gendered", "dangling"], ["dangling"], "מה ה")).toBe("safe");
  });
});
