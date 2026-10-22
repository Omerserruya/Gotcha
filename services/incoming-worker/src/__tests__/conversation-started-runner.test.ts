/**
 * The runner fires "New conversation" (conversation_started) only while nobody
 * owns the conversation, and a channel's own routing automation beats one for
 * every channel (2026-10-22). The playbook's two rules, kept.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ askedTypes: [] as string[][] }));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    prisma: {
      message: { count: vi.fn(async () => 1) },
      conversation: { count: vi.fn(async () => 0), updateMany: vi.fn(), findFirst: vi.fn(async () => null) },
      chatbotFlow: {
        // Record what the runner asked for; return nothing so no walk starts.
        findMany: vi.fn(async (a: any) => { H.askedTypes.push(a.where.triggerType.in); return []; }),
      },
    },
  };
});

import { automationsForInbound, routingFallbackLast } from "../services/automation-runner.service";

const base = { id: "c1", channel: "WHATSAPP", customerExternalId: "972500000000", handledBy: null, chatbotNodeId: null, automationRunId: null, assignedAiAgentId: null };
const run = (conv: Partial<typeof base>, extra: any = {}) =>
  automationsForInbound({ tenantId: "t1", conversation: { ...base, ...conv } as any, messageId: "m1", message: "hi", channel: "whatsapp", ...extra });

beforeEach(() => { H.askedTypes = []; });

describe("★ conversation_started fires only while nobody owns the conversation", () => {
  it("unowned: asked for", async () => {
    await run({});
    expect(H.askedTypes[0]).toContain("conversation_started");
    expect(H.askedTypes[0]).toContain("message_received");
  });

  it("an AI employee already owns it: not asked for (no re-stamping per message)", async () => {
    await run({ assignedAiAgentId: "emp_1", handledBy: "ai_agent" });
    expect(H.askedTypes[0]).not.toContain("conversation_started");
    expect(H.askedTypes[0]).toContain("message_received");
  });

  it("owned by a flow or handled otherwise: not asked for", async () => {
    await run({ handledBy: "human" });
    expect(H.askedTypes[0]).not.toContain("conversation_started");
  });

  it("a story mention is not a conversation start", async () => {
    await run({}, { storyMention: { url: null } });
    expect(H.askedTypes[0]).not.toContain("conversation_started");
  });
});

describe("★ routingFallbackLast: a channel's own route beats every-channel, otherwise activation order", () => {
  it("moves channel-less routing automations last, keeps the rest in order", () => {
    const flows = [
      { id: "all", triggerType: "conversation_started", triggerConfig: {} },
      { id: "greet", triggerType: "message_received", triggerConfig: {} },
      { id: "wa", triggerType: "conversation_started", triggerConfig: { channels: ["WHATSAPP"] } },
      { id: "all2", triggerType: "conversation_started", triggerConfig: { channels: [] } },
    ];
    expect(routingFallbackLast(flows).map((f) => f.id)).toEqual(["greet", "wa", "all", "all2"]);
  });

  it("other trigger types without channels are not moved", () => {
    const flows = [
      { id: "a", triggerType: "message_received", triggerConfig: {} },
      { id: "b", triggerType: "new_customer", triggerConfig: { channels: ["WHATSAPP"] } },
    ];
    expect(routingFallbackLast(flows).map((f) => f.id)).toEqual(["a", "b"]);
  });
});
