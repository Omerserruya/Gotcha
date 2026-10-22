/**
 * Which knowledge misses become "unanswered questions" the owner is asked to
 * teach (00h). Not the test chat's rehearsals, not a thank-you - the dev list
 * held "תודה רבה" (asked 5 times) and the skill test-chat lines.
 */
import { describe, it, expect } from "vitest";
import { shouldRecordKnowledgeGap } from "../services/knowledge.service";

describe("shouldRecordKnowledgeGap", () => {
  it("★ a real customer's question is recorded", () => {
    expect(shouldRecordKnowledgeGap({ customerExternalId: "972501234567", message: "האם יש לכם משלוח לאילת?" })).toBe(true);
    expect(shouldRecordKnowledgeGap({ customerExternalId: "972501234567", message: "Do you ship to Eilat?" })).toBe(true);
  });

  it("★ the test chat is never recorded: a sandbox turn, or a sandbox conversation", () => {
    expect(shouldRecordKnowledgeGap({ sandbox: true, customerExternalId: "972501234567", message: "האם יש לכם משלוח לאילת?" })).toBe(false);
    expect(shouldRecordKnowledgeGap({ customerExternalId: "sandbox:cms729b4e", message: "אני רוצה להחליף את הטרנץ' קוט ממידה S למידה M" })).toBe(false);
  });

  it("★ a thank-you, an ok, a greeting or an emoji is not a question", () => {
    for (const m of ["תודה רבה", "תודה!", "thanks a lot", "Thank you so much", "בסדר גמור", "שלום לכם", "👍", "ok"]) {
      expect(shouldRecordKnowledgeGap({ customerExternalId: "972501234567", message: m }), m).toBe(false);
    }
  });
});

describe("isOnlyCourtesy", () => {
  it("the whole message must be courtesy: a thank-you with a question is a question", async () => {
    const { isOnlyCourtesy } = await import("../services/knowledge.service");
    expect(isOnlyCourtesy("תודה רבה!!")).toBe(true);
    expect(isOnlyCourtesy("🙏🙏")).toBe(true);
    expect(isOnlyCourtesy("thanks, do you ship to Eilat?")).toBe(false);
    expect(isOnlyCourtesy("תודה, יש לכם משלוח לאילת?")).toBe(false);
    expect(isOnlyCourtesy("לא קיבלתי את ההזמנה")).toBe(false);
  });
});
