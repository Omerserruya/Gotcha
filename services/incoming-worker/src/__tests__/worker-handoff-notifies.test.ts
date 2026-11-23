/**
 * A handoff the worker makes tells the team (2026-10-25, eval L01c): AI units ran
 * out, the AI call failed, the customer heard "a person will pick up", and the
 * notifications service never heard of it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf8");

describe("★ worker handoffs notify", () => {
  it("escalateToHuman emits conversation.escalated unless the AI turn already did", () => {
    expect(src).toContain("if (reason?.notify !== false) {");
    expect(src).toContain("emitEscalated({ tenantId, conversationId, agentId: aiAgentId, reason: reason?.case ?? \"handoff\", summary: reason?.summary });");
  });
  it("an AI-decided escalation is announced by the AI; a billing block, and a reply engine v2 hand-over (announce), by the worker", () => {
    expect(src).toContain('notify: /^billing_blocked/.test(String(result.escalation.reason ?? "")) || result.escalation.announce === true,');
  });
  it("AI units exhausted is labelled a billing block, not an AI failure", () => {
    expect(src).toContain('const unitsOut = /^ai_units:/.test(String(err.response?.data?.error ?? ""));');
    expect(src).toContain('case: `billing_blocked:${String(err.response?.data?.error).slice("ai_units:".length)}`');
  });
  it("the emitter uses the notifications service's queue", () => {
    const emit = readFileSync(join(__dirname, "../services/notifications-emit.ts"), "utf8");
    expect(emit).toContain('new Queue("notifications"');
    expect(emit).toContain('type: "conversation.escalated"');
  });
});
