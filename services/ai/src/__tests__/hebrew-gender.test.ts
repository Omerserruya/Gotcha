import { describe, it, expect } from "vitest";
import { guardCustomerReply } from "../services/reply-guard.service";

/**
 * Hebrew is grammatically gendered, so an AI employee has to decide what it is
 * and stay that way, and has to address the customer without hedging.
 *
 * Maya did neither. Her persona was `{"brand_archetype":"high_energy_coach"}` -
 * no gender at all - and the prompt builder only emitted a gender instruction
 * `if (persona.gender)`. So nothing told her. Her feminine name carried her
 * most of the way ("בודקת", "אני יכולה", "אני אישה") and then she wrote
 * "מציע/ה" about herself.
 *
 * Separately she addressed Matan - a man, who had written "לא הבנתי" in
 * masculine - as "מאשר/ת", because rule 10 said "low confidence → neutral
 * phrasing" and the model rendered "neutral" as a slash. A slash form is not
 * neutral; it is a form field.
 */

const HE = { locale: "he" };

describe("slash forms are detected", () => {
  const SLASHED = [
    "מאשר/ת שאעשה את זה עכשיו?",
    "מציע/ה להמשיך בשני צעדים.",
    "אני יכול/ה לבדוק את זה.",
    "האם אתה/את רוצה לבטל?",
    "מעוניין/ת לשמוע עוד?",
  ];

  it.each(SLASHED)("flags %j", (line) => {
    const r = guardCustomerReply(line, HE);
    expect(r.findings.some((f) => f.kind === "slash_form"), `no slash finding for: ${line}`).toBe(true);
  });

  it("flags the exact self-referential slash Maya produced", () => {
    // 12:41 in the real conversation.
    const r = guardCustomerReply("מציע/ה להמשיך בשני צעדים עכשיו.", HE);
    const hit = r.findings.find((f) => f.kind === "slash_form");
    expect(hit?.match).toBe("מציע/ה");
  });
});

describe("it does not cry wolf on ordinary Hebrew", () => {
  const CLEAN = [
    "ההזמנה שלך יצאה לדרך ותגיע תוך 3 ימי עסקים.",
    "אפשר לבצע את הפעולה עכשיו?",
    "לבדוק את זה עכשיו?",
    "להמשיך לביטול ההזמנה?",
    "אני בודקת את זה ומעדכנת מיד.",
    "המשלוח יוצא ב-7/8 לחודש.",       // a date, not a slash form
    "אפשר לשלם באשראי ו/או בהעברה.",   // "ו/או" is a real conjunction
    "https://example.com/orders/1006", // a URL
  ];

  it.each(CLEAN)("leaves %j unflagged", (line) => {
    const r = guardCustomerReply(line, HE);
    expect(r.findings.some((f) => f.kind === "slash_form"), `false positive on: ${line}`).toBe(false);
  });
});

describe("the restructured alternatives the rule prescribes", () => {
  // Each pair is ❌/✅ from prompt rule 10a. The right-hand form must be clean,
  // which is what makes the rule followable rather than merely stated.
  const PAIRS: Array<[string, string]> = [
    ["מאשר/ת שאעשה את זה עכשיו?", "אפשר לבצע את הפעולה עכשיו?"],
    ["רוצה/ה שאבדוק?", "לבדוק את זה עכשיו?"],
    ["האם אתה/את רוצה לבטל?", "להמשיך לביטול ההזמנה?"],
    ["מעוניין/ת לשמוע עוד?", "אפשר לשלוח פרטים נוספים?"],
  ];

  it.each(PAIRS)("%j is flagged, %j is not", (bad, good) => {
    expect(guardCustomerReply(bad, HE).findings.some((f) => f.kind === "slash_form")).toBe(true);
    expect(guardCustomerReply(good, HE).findings.some((f) => f.kind === "slash_form")).toBe(false);
  });
});

describe("what the employee says about herself", () => {
  it("accepts consistent feminine first person", () => {
    // Every one of these is a real Maya line that was CORRECT.
    for (const line of [
      "רגע אחד, בודקת שוב סטטוס המשלוח.",
      "אני יכולה לפנות לצוות ולבדוק.",
      "אני אישה, שמי מיה.",
      "ניסיתי לבדוק את זה עבורך.",
      "אעביר את הפרטים הלאה.",
    ]) {
      expect(guardCustomerReply(line, { ...HE, evidence: { taskCreated: true } })
        .findings.some((f) => f.kind === "slash_form"), line).toBe(false);
    }
  });

  it("catches a masculine slip inside an otherwise feminine reply", () => {
    // The real failure mode: she was feminine all conversation, then hedged.
    const mixed = "בדקתי את ההזמנה עבורך. מציע/ה להמשיך בשני צעדים.";
    const r = guardCustomerReply(mixed, HE);
    expect(r.findings.some((f) => f.kind === "slash_form")).toBe(true);
  });
});
