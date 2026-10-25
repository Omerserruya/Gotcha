/** P4 (2026-10-25): per-situation evidence from the agents' own replies, anonymised. */
import { describe, it, expect } from "vitest";
import { classifySituation, stripPii, pairAgentReplies, renderSituationEvidence } from "../services/historical-intelligence/brand-voice";

const at = (m: number) => new Date(Date.UTC(2026, 9, 1, 10, m));

describe("★ situations", () => {
  it.each([
    ["כמה עולה החולצה?", "price"], ["יש הנחה?", "price"],
    ["מתי זה יגיע?", "shipping"], ["אזל במידה M?", "out_of_stock"],
    ["החבילה לא הגיעה, ממש מבאס", "complaint"], ["תודה רבה!", "closing"],
  ])("%s -> %s", (t, s) => expect(classifySituation(t, false)).toBe(s));
  it("the agent's first reply in a conversation is the opening", () => {
    expect(classifySituation("היי", true)).toBe("opening");
    expect(classifySituation("היי", false)).toBeNull();
  });
});

describe("★ PII is stripped, the brand's register is kept", () => {
  it("contacts, links, numbers and the name after a greeting", () => {
    expect(stripPii("היי דנה, ההזמנה 104523 בדרך, מעקב https://x.co/t?1 או 050-1234567, dana@x.com"))
      .toBe("היי [name], ההזמנה [number] בדרך, מעקב [link] או [phone], [email]");
  });
  it("an endearment is the register, not a name", () => {
    expect(stripPii("היי אהובה ❤️ יש במלאי")).toBe("היי אהובה ❤️ יש במלאי");
  });
});

describe("★ pairs", () => {
  const msgs = [
    { direction: "INBOUND" as const, body: "היי", conversationId: "c1", at: at(0) },
    { direction: "OUTBOUND" as const, body: "היי אהובה ❤️ מה מחפשים?", conversationId: "c1", at: at(1) },
    { direction: "INBOUND" as const, body: "כמה עולה הקרדיגן?", conversationId: "c1", at: at(2) },
    { direction: "OUTBOUND" as const, body: "529 ₪ 🙂", conversationId: "c1", at: at(3) },
    { direction: "OUTBOUND" as const, body: "עוד משהו?", conversationId: "c1", at: at(4) },
  ];
  it("each reply with the customer message before it; a second reply in a row is not paired", () => {
    expect(pairAgentReplies(msgs)).toEqual([
      { customer: "היי", agent: "היי אהובה ❤️ מה מחפשים?", firstOfConversation: true },
      { customer: "כמה עולה הקרדיגן?", agent: "529 ₪ 🙂", firstOfConversation: false },
    ]);
  });
  it("the evidence groups by situation, says which have none, and asks for rules", () => {
    const ev = renderSituationEvidence(pairAgentReplies(msgs));
    expect(ev).toContain("write RULES from them, never quote them");
    expect(ev).toContain("## opening (1 seen)");
    expect(ev).toContain("## price (1 seen)");
    expect(ev).toContain("## complaint (0 seen)\n  (no evidence: leave this situation empty)");
  });
});
