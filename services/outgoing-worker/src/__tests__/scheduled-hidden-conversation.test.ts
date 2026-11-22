/**
 * A hidden conversation (packages/shared relevance-hidden.ts, 2026-11-22): what the AI or an automation
 * scheduled there is cancelled when it comes due; a person's own scheduled message still goes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  due: [] as any[],
  updates: [] as any[],
  sent: [] as any[],
  flows: [] as any[],
  conversations: {} as Record<string, any>,
  users: new Set<string>(),
}));

vi.mock("@chatcenter/shared", () => ({
  prisma: {
    scheduledMessage: {
      findMany: async () => H.due.map((d) => ({ ...d })),
      update: async (a: any) => { H.updates.push({ id: a.where.id, ...a.data }); return {}; },
    },
    conversation: {
      findFirst: async (a: any) => {
        const c = H.conversations[a.where.id];
        return c && c.tenantId === a.where.tenantId ? c : null;
      },
    },
    user: { findFirst: async (a: any) => (H.users.has(`${a.where.tenantId}:${a.where.id}`) ? { id: a.where.id } : null) },
    message: { create: async (a: any) => ({ id: `msg-${a.data.scheduledMessageId}` }) },
    messageTemplate: { findUnique: async () => null },
  },
  outgoingMessageQueue: { add: async (_n: string, d: any) => { H.sent.push(d); } },
  flowResumeQueue: { add: async (_n: string, d: any) => { H.flows.push(d); } },
  scheduledMessageQueue: { add: async () => undefined },
  createWorker: () => undefined,
  resolveContactByChannelId: async () => null,
}));

import { processScheduledMessages, HIDDEN_CANCEL_REASON, writtenByPerson } from "../workers/scheduled.worker";

const sm = (id: string, o: any = {}) => ({
  id, tenantId: "t1", conversationId: "c-hidden", channel: "WHATSAPP", channelAccountId: "ca1", recipientExternalId: "9725",
  body: "Checking in", messageType: "text", mediaUrl: null, templateId: null, variables: {}, flowId: null, createdBy: "ai_agent", ...o,
});

beforeEach(() => {
  H.updates = []; H.sent = []; H.flows = [];
  H.users = new Set(["t1:u-dana"]);
  H.conversations = {
    "c-hidden": { tenantId: "t1", relevanceCategory: "personal", relevanceConfidence: 0.92, relevanceOverriddenBy: null, channelAccount: { relevanceFilterEnabled: true } },
    "c-marked": { tenantId: "t1", relevanceCategory: "personal", relevanceConfidence: null, relevanceOverriddenBy: "u-dana", channelAccount: null },
    "c-business": { tenantId: "t1", relevanceCategory: "personal", relevanceConfidence: 0.5, relevanceOverriddenBy: "u-dana", channelAccount: null },
    "c-open": { tenantId: "t1", relevanceCategory: "business", relevanceConfidence: 0.9, relevanceOverriddenBy: null, channelAccount: null },
    "c-filter-off": { tenantId: "t1", relevanceCategory: "personal", relevanceConfidence: 0.99, relevanceOverriddenBy: null, channelAccount: { relevanceFilterEnabled: false } },
  };
  H.conversations["c-business"].relevanceCategory = "business";
});

describe("scheduled messages on a hidden conversation", () => {
  it("the AI's follow-up and an automation's flow kick are cancelled, nothing is sent or started", async () => {
    H.due = [sm("s-ai"), sm("s-agent", { createdBy: "agent-maya" }), sm("s-flow", { flowId: "f1", createdBy: "automation" })];
    await processScheduledMessages();
    expect(H.sent).toEqual([]);
    expect(H.flows).toEqual([]);
    expect(H.updates).toEqual([
      { id: "s-ai", status: "CANCELLED", error: HIDDEN_CANCEL_REASON },
      { id: "s-agent", status: "CANCELLED", error: HIDDEN_CANCEL_REASON },
      { id: "s-flow", status: "CANCELLED", error: HIDDEN_CANCEL_REASON },
    ]);
  });

  it("a person's hand mark hides it the same way", async () => {
    H.due = [sm("s-ai", { conversationId: "c-marked" })];
    await processScheduledMessages();
    expect(H.sent).toEqual([]);
    expect(H.updates[0]).toMatchObject({ status: "CANCELLED" });
  });

  it("a person's own scheduled message on it still goes", async () => {
    H.due = [sm("s-dana", { createdBy: "u-dana" })];
    await processScheduledMessages();
    expect(H.sent).toHaveLength(1);
    expect(H.updates[0]).toMatchObject({ id: "s-dana", status: "SENT" });
  });

  it("a user of ANOTHER workspace is not a person here", async () => {
    H.users = new Set(["t2:u-dana"]);
    expect(await writtenByPerson("t1", "u-dana")).toBe(false);
    expect(await writtenByPerson("t2", "u-dana")).toBe(true);
    expect(await writtenByPerson("t1", "")).toBe(false);
  });

  it("not hidden (business, a person's business mark, filter off, no conversation): sent as before", async () => {
    H.due = [
      sm("s1", { conversationId: "c-open" }),
      sm("s2", { conversationId: "c-business" }),
      sm("s3", { conversationId: "c-filter-off" }),
      sm("s4", { conversationId: null }),
    ];
    await processScheduledMessages();
    expect(H.sent.map((s) => s.messageId)).toEqual(["msg-s1", "msg-s2", "msg-s3", "msg-s4"]);
    expect(H.updates.every((u) => u.status === "SENT")).toBe(true);
  });
});
