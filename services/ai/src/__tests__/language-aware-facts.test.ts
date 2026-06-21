import { describe, it, expect } from "vitest";
import { computeKnowledgeLedger } from "../services/knowledge-ledger";
import { requiredKnowledgeFor } from "../services/skills";
import { selectActiveObjective } from "../services/objectives";

/**
 * The omer "lost context" root cause: the Knowledge Ledger matches a field's
 * ENGLISH key/sourceHints (business_type / industry / company) as substrings of
 * the resolved-fact text. A Hebrew answer never contains those tokens, so
 * business_type stayed "missing" forever and the objective froze in
 * GENERATE_LEAD. The fix emits a KEYED fact line ("- business_type: …") into the
 * fact block; these tests pin that the keyed line makes the match work while the
 * raw Hebrew transcript alone does not.
 */
describe("knowledge ledger — Hebrew answer needs a keyed fact to register", () => {
  const sales = requiredKnowledgeFor("sales");
  const isKnown = (factText: string, key: string) =>
    computeKnowledgeLedger(sales, factText).entries.find((e) => e.key === key)?.known;

  it("sanity: business_type is a required field for sales", () => {
    expect(sales.some((f) => f.key === "business_type")).toBe(true);
  });

  it("BUG repro: raw Hebrew transcript alone does NOT register business_type", () => {
    const hebrewTranscript = '- "מכירה"\n- "פלטפורמה לניהול מלאי"';
    expect(isKnown(hebrewTranscript, "business_type")).toBe(false);
  });

  it("FIX: a keyed fact line registers business_type (language-independent)", () => {
    const withKeyed =
      '- "פלטפורמה לניהול מלאי"\n' +
      "## Facts established this conversation (keyed)\n" +
      "- business_type: inventory management platform";
    expect(isKnown(withKeyed, "business_type")).toBe(true);
  });

  it("English answer that happens to use a hint word still works (unchanged)", () => {
    expect(isKnown("- we are an inventory management company", "business_type")).toBe(true); // 'company' hint
  });
});

describe("objective promotion — Hebrew 'schedule a call' + value-based identity", () => {
  // Reproduces omer's blocked promotion: he asked to schedule (in Hebrew) and
  // gave an email, but the agent kept qualifying. The promotion needs the Hebrew
  // meeting intent AND value-detected identity to fire.
  const heBookingFacts = [
    "- Customer Name: עומר",
    '- "בוא נקבע שיחה"',                       // "let's schedule a call" (Hebrew)
    "- business_type: inventory platform",      // keyed (so GENERATE_LEAD is done)
    '- "המייל שלי omer@example.com"',           // email VALUE (no literal "email" hint word)
  ].join("\n");

  it("promotes BOOK_MEETING for a NEW prospect who asked (in Hebrew) and is reachable", () => {
    const status = selectActiveObjective("sales", "NEW_PROSPECT", heBookingFacts);
    expect(status?.objective.id).toBe("BOOK_MEETING");
  });

  it("does NOT promote when there's no contact (can't reach them)", () => {
    const noContact = '- Customer Name: עומר\n- "בוא נקבע שיחה"\n- business_type: x';
    const status = selectActiveObjective("sales", "NEW_PROSPECT", noContact);
    expect(status?.objective.id).not.toBe("BOOK_MEETING");
  });
});
