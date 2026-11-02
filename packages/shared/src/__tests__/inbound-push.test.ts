/**
 * ★ message.inbound, the rule and the event (mobile push, 2026-11-03), shared
 * by the incoming worker and services/ai's chat routes:
 *   - who is told: an assignee, the bot not driving, real traffic only
 *   - the preview: ~100 characters, or the media kind
 *   - the payload on the notifications queue
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const Q = vi.hoisted(() => ({ adds: [] as any[] }));
vi.mock("bullmq", () => ({
  Queue: class { name: string; constructor(name: string) { this.name = name; } add = async (name: string, data: any, opts: any) => { Q.adds.push({ queue: this.name, name, data, opts }); return { id: "j" }; } },
}));

import { emitInboundMessage, inboundPreview, shouldEmitInbound } from "../lib/notifications/inbound-push";

const flush = () => new Promise((r) => setImmediate(r));
beforeEach(() => { Q.adds = []; });

describe("★ who is told", () => {
  it("a person assigned and the bot not driving: yes", () => {
    expect(shouldEmitInbound({ assignedAgentId: "matan", handledBy: "human" })).toBe(true);
    expect(shouldEmitInbound({ assignedAgentId: "matan", handledBy: null })).toBe(true);
  });
  it("no assignee but with the team (handed over, or a person replied from the queue): yes, for the team", () => {
    expect(shouldEmitInbound({ assignedAgentId: null, isHandedOver: true, handledBy: "human" })).toBe(true);
    expect(shouldEmitInbound({ assignedAgentId: null, isHandedOver: true, handledBy: null })).toBe(true);
    expect(shouldEmitInbound({ assignedAgentId: null, isHandedOver: false, handledBy: "human" })).toBe(true);
  });
  it("no assignee and nobody has it (unrouted): no", () => {
    expect(shouldEmitInbound({ assignedAgentId: null, isHandedOver: false, handledBy: null })).toBe(false);
    expect(shouldEmitInbound({})).toBe(false);
  });
  it("not real traffic: a sandbox rehearsal, a test conversation, imported history", () => {
    const human = { assignedAgentId: "matan", handledBy: "human" };
    expect(shouldEmitInbound({ ...human, customerExternalId: "sandbox:abc" })).toBe(false);
    expect(shouldEmitInbound({ ...human, isTest: true })).toBe(false);
    expect(shouldEmitInbound({ ...human, origin: "HISTORICAL_IMPORT" })).toBe(false);
    expect(shouldEmitInbound({ ...human, origin: "LIVE", isTest: false, customerExternalId: "9725" })).toBe(true);
  });

  it("the bot, a flow, a pending approval or the sandbox driving: no, assignee or handed over or not", () => {
    for (const handledBy of ["ai_agent", "awaiting_approval", "flow", "sandbox"]) {
      expect(shouldEmitInbound({ assignedAgentId: "matan", handledBy }), handledBy).toBe(false);
      expect(shouldEmitInbound({ assignedAgentId: null, isHandedOver: true, handledBy }), handledBy).toBe(false);
    }
  });
});

describe("★ the preview", () => {
  it("the first ~100 characters, whitespace folded", () => {
    expect(inboundPreview("  Is it\n in stock? ", "text")).toEqual({ preview: "Is it in stock?", previewKind: "text" });
    const long = inboundPreview("x".repeat(300), "text").preview;
    expect(long.length).toBe(100);
    expect(long.endsWith("\u2026")).toBe(true);
  });
  it("a media placeholder is a media preview; a caption is text", () => {
    expect(inboundPreview("[Image]", "image")).toEqual({ preview: "[Image]", previewKind: "media" });
    expect(inboundPreview("", "audio")).toEqual({ preview: "[audio]", previewKind: "media" });
    expect(inboundPreview("look at this", "image")).toEqual({ preview: "look at this", previewKind: "text" });
  });
});

describe("★ the event", () => {
  it("goes on the notifications queue with the agreed payload", async () => {
    const queued = emitInboundMessage({
      tenantId: "t1",
      conversation: { id: "c1", assignedAgentId: "matan", handledBy: "human", customerName: "Omer", departmentId: "d1" },
      messageId: "m9", body: "hello", messageType: "text", channel: "WHATSAPP",
    });
    expect(queued).toBe(true);
    await flush();
    expect(Q.adds).toHaveLength(1);
    const { queue, name, data, opts } = Q.adds[0];
    expect([queue, name]).toEqual(["notifications", "message.inbound"]);
    expect(data).toMatchObject({
      type: "message.inbound", tenantId: "t1", departmentId: "d1",
      data: { conversationId: "c1", assignedAgentId: "matan", messageId: "m9", preview: "hello", previewKind: "text", messageType: "text", channel: "WHATSAPP", customerName: "Omer" },
      metadata: { conversationId: "c1", userId: "matan" },
    });
    expect(opts.jobId).toBe(`evt-${data.id}`);
  });

  it("the team's queue: queued with no assignee, for the engine to route as an escalation", async () => {
    expect(emitInboundMessage({ tenantId: "t1", conversation: { id: "c2", assignedAgentId: null, isHandedOver: true, handledBy: "human", departmentId: "sales" }, messageId: "m2", body: "still there?", messageType: "text", channel: "WEBCHAT" })).toBe(true);
    await flush();
    expect(Q.adds[0].data).toMatchObject({ departmentId: "sales", data: { conversationId: "c2", assignedAgentId: null, preview: "still there?" }, metadata: { conversationId: "c2" } });
    expect(Q.adds[0].data.metadata.userId).toBeUndefined();
  });

  it("refused: nothing queued", async () => {
    expect(emitInboundMessage({ tenantId: "t1", conversation: { id: "c1", assignedAgentId: "matan", handledBy: "ai_agent" }, messageId: "m1", body: "hi", messageType: "text", channel: "WHATSAPP" })).toBe(false);
    await flush();
    expect(Q.adds).toHaveLength(0);
  });
});

