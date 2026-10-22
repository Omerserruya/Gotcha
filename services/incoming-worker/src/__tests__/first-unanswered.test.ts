/**
 * ★ Which inbound message gets routed (the playbook decides who answers):
 * found live on dev - a visitor who opened with "הסר" (answered only by the
 * opt-out confirmation) and then asked a question got no answer at all, the
 * same as one who opened with a sticker (the unsupported-media notice).
 *   - the first message, always
 *   - while unowned, the first one after only system replies or an
 *     automation's
 *   - never once a person, the AI or a flow owns it, or someone answered
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ messages: [] as any[] }));

function holds(m: any, w: any): boolean {
  return Object.entries(w).every(([k, v]: [string, any]) => {
    if (k === "OR") return v.some((x: any) => holds(m, x));
    if (v && typeof v === "object" && "not" in v) return m[k] != null && m[k] !== v.not;
    return (m[k] ?? null) === v;
  });
}

vi.mock("@chatcenter/shared", () => ({
  prisma: { message: { count: async (a: any) => H.messages.filter((m) => holds(m, a.where)).length } },
}));

import { isFirstUnanswered } from "../services/first-unanswered.service";

const conv = (o: any = {}) => ({ id: "c1", handledBy: null, assignedAiAgentId: null, chatbotNodeId: null, automationRunId: null, ...o });
const msg = (direction: string, senderName: string | null) => ({ conversationId: "c1", direction, senderName });
const noAutomation = async () => false;

beforeEach(() => { H.messages = []; });

describe("★ the first message that should be routed", () => {
  it("the first message", async () => {
    H.messages = [msg("INBOUND", "Dana")];
    expect(await isFirstUnanswered("T", conv(), noAutomation)).toBe(true);
  });

  it("★ after 'הסר' and its confirmation (or the unsupported-media notice), the next question is routed", async () => {
    H.messages = [msg("INBOUND", "Dana"), msg("OUTBOUND", "System"), msg("INBOUND", "Dana")];
    expect(await isFirstUnanswered("T", conv(), noAutomation)).toBe(true);
  });

  it("after an automation answered, while unowned", async () => {
    H.messages = [msg("INBOUND", "Dana"), msg("OUTBOUND", "Automation"), msg("INBOUND", "Dana")];
    expect(await isFirstUnanswered("T", conv(), async () => true)).toBe(true);
  });

  it("not once someone answered (a reply with no sender name counts)", async () => {
    H.messages = [msg("INBOUND", "Dana"), msg("OUTBOUND", "Maya"), msg("INBOUND", "Dana")];
    expect(await isFirstUnanswered("T", conv(), noAutomation)).toBe(false);
    H.messages = [msg("INBOUND", "Dana"), msg("OUTBOUND", null), msg("INBOUND", "Dana")];
    expect(await isFirstUnanswered("T", conv(), noAutomation)).toBe(false);
  });

  it.each([["the AI", { handledBy: "ai_agent" }], ["an employee", { assignedAiAgentId: "ag1" }], ["a flow", { chatbotNodeId: "n1" }], ["an automation run", { automationRunId: "r1" }]])(
    "not once %s owns it", async (_n, o) => {
      H.messages = [msg("INBOUND", "Dana"), msg("OUTBOUND", "System"), msg("INBOUND", "Dana")];
      expect(await isFirstUnanswered("T", conv(o), noAutomation)).toBe(false);
    });
});
