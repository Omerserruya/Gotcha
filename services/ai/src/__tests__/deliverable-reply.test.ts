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

describe("★ e5 S2: a silent turn after a bare thank-you closes warmly, never the failure line", () => {
  it("the close, not 'לא הצלחתי להשלים את הבדיקה'", async () => {
    const { deliverableReply } = await import("../services/ai-bot.service");
    const { closingReplyFor } = await import("../services/reply-style-check.service");
    const out = deliverableReply({ safeReply: null, pendingEscalation: false, awaitingApproval: false, toolCallLog: [], locale: "he", closing: closingReplyFor("תודה רבה!", "he") });
    expect(out).toBe("בכיף 🙂");
  });
  it("anything but a bare closing still gets the honest fallback", async () => {
    const { closingReplyFor } = await import("../services/reply-style-check.service");
    expect(closingReplyFor("תודה, ומתי זה יגיע?", "he")).toBeNull();
  });
  it("an interim-only reply after thanks becomes the close", () => {
    const { readFileSync } = require("node:fs");
    const { join } = require("node:path");
    const src: string = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf8");
    expect(src).toContain('replyText = closingReplyFor(opts.incomingMessage ?? "", replyLocale);');
  });
});
