/**
 * What an empty turn delivers. The honest fallback, unless an escalation or
 * an approval already owes the customer a message from another path - and a
 * SIMULATED escalation (the test chat) counts, or the test chat shows a
 * message ("I couldn't finish checking") live would never send.
 */
import { describe, it, expect } from "vitest";
import { deliverableReply } from "../services/ai-bot.service";

const base = { safeReply: "", pendingEscalation: false, awaitingApproval: false, toolCallLog: [] as any[], locale: "he" };

describe("deliverableReply", () => {
  it("a reply is delivered as is", () => {
    expect(deliverableReply({ ...base, safeReply: "שלום" })).toBe("שלום");
  });
  it("an empty turn with nothing pending gets the fallback", () => {
    expect(deliverableReply(base)).toMatch(/לא הצלחתי להשלים/);
    expect(deliverableReply({ ...base, locale: "en" })).toMatch(/couldn't finish checking/);
  });
  it("a live escalation or an approval pause owes its own message: no fallback", () => {
    expect(deliverableReply({ ...base, pendingEscalation: true })).toBe("");
    expect(deliverableReply({ ...base, awaitingApproval: true })).toBe("");
  });
  it("★ a simulated escalation (test chat) is an escalation too: no fallback", () => {
    expect(deliverableReply({ ...base, toolCallLog: [{ tool: "escalate_to_human", decision: "simulated" }] })).toBe("");
  });
  it("a simulated write that is not an escalation does not excuse silence", () => {
    expect(deliverableReply({ ...base, toolCallLog: [{ tool: "woocommerce.update_order_status", decision: "simulated" }] })).toMatch(/לא הצלחתי/);
  });
});
