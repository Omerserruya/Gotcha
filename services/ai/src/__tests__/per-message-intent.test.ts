/**
 * Per-message intent: a writer for a convention that already had a reader.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * `conversation-memory.service.ts:125` reads `m.metadata?.intent` and documents
 * "BEL/runtime-tagged metadata wins - explicit > heuristic", falling back at
 * :146 to keyword matching "only if metadata didn't already say".
 *
 * ★ Nothing had ever written it. No message-intent column exists in any of 207
 * migrations and no writer set the metadata key — so that precedence rule was
 * written, shipped, and never once fired: the consumer ran on keyword
 * heuristics one hundred percent of the time, silently.
 *
 * `analyzeConversation` already classifies ONE specific inbound message and kept
 * the answer only at conversation level. So this is storage, not a new
 * classifier — no extra model call, and the value is the one already in hand.
 * ════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  messages: [] as any[],
  updates: [] as any[],
  classifyCalls: 0,
  classifyResult: { intent: "refund_request", confidence: 0.91, entities: [] } as any,
  classifyThrows: false,
  updateThrows: false,
}));

vi.mock("@chatcenter/shared", () => ({
  prisma: {
    conversation: { findFirst: async () => ({ id: "cv1", tenantId: "t1" }), update: async () => ({}) },
    message: {
      findMany: async () => state.messages,
      update: async (a: any) => {
        state.updates.push(a);
        if (state.updateThrows) throw new Error("write failed");
        return {};
      },
    },
    conversationIntelligence: { findFirst: async () => null, upsert: async () => ({ id: "ci1" }) },
    // Exhaustive: every prisma.X.Y the service touches, listed from the source
    // rather than from what the first failure happened to name.
    toolExecution: { findMany: async () => [] },
  },
  resolveEffectiveLocale: async () => ({ effective: "en" }),
}));

vi.mock("../services/ai-assist.service", () => ({
  classifyMessage: async () => {
    state.classifyCalls += 1;
    if (state.classifyThrows) throw new Error("classifier down");
    return state.classifyResult;
  },
  classifySentiment: async () => ({ sentiment: "neutral", score: 0 }),
  summarizeConversation: async () => "a summary",
  getProvider: () => ({}),
}));

import { analyzeConversation } from "../services/conversation-intelligence.service";

const msg = (o: Partial<any> = {}) => ({
  id: "m1", direction: "INBOUND", body: "where is my refund", senderName: "Dana",
  createdAt: new Date(), metadata: null, messageType: "text", ...o,
});

beforeEach(() => {
  state.messages = [msg()];
  state.updates = [];
  state.classifyCalls = 0;
  state.classifyResult = { intent: "refund_request", confidence: 0.91, entities: [] };
  state.classifyThrows = false;
  state.updateThrows = false;
});

describe("★ the intent lands on the message it was computed from", () => {
  it("★ writes intent and confidence into that message's metadata", async () => {
    await analyzeConversation("t1", "cv1");

    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].where).toEqual({ id: "m1" });
    expect(state.updates[0].data.metadata).toMatchObject({
      intent: "refund_request",
      intentConfidence: 0.91,
    });
  });

  it("★ uses the key the EXISTING consumer reads", async () => {
    await analyzeConversation("t1", "cv1");

    // conversation-memory.service.ts:125 reads `m.metadata?.intent` exactly.
    // A different key here would leave that precedence dead, which is the whole
    // defect being fixed.
    expect("intent" in state.updates[0].data.metadata).toBe(true);
  });

  it("★ costs NO extra model call", async () => {
    await analyzeConversation("t1", "cv1");

    // Storage, not a new classifier. One classification, as before.
    expect(state.classifyCalls).toBe(1);
  });

  it("★ MERGES into existing metadata rather than replacing it", async () => {
    state.messages = [msg({ metadata: { source: "whatsapp", sandbox: false } })];

    await analyzeConversation("t1", "cv1");

    expect(state.updates[0].data.metadata).toEqual({
      source: "whatsapp",
      sandbox: false,
      intent: "refund_request",
      intentConfidence: 0.91,
    });
  });

  it("handles a message with no metadata at all", async () => {
    state.messages = [msg({ metadata: null })];

    await analyzeConversation("t1", "cv1");

    expect(state.updates[0].data.metadata).toEqual({ intent: "refund_request", intentConfidence: 0.91 });
  });

  it("classifies the LAST inbound, and writes to that one", async () => {
    state.messages = [
      msg({ id: "m1", body: "hello" }),
      msg({ id: "m2", direction: "OUTBOUND", body: "hi" }),
      msg({ id: "m3", body: "where is my refund" }),
    ];

    await analyzeConversation("t1", "cv1");

    expect(state.updates[0].where).toEqual({ id: "m3" });
  });

  it("ignores system messages when picking the target", async () => {
    state.messages = [
      msg({ id: "m1", body: "where is my refund" }),
      msg({ id: "m2", body: "", messageType: "system" }),
    ];

    await analyzeConversation("t1", "cv1");

    expect(state.updates[0].where).toEqual({ id: "m1" });
  });
});

describe("★ a failed write costs history, never correctness", () => {
  it("★ does not fail the analysis when the message update throws", async () => {
    state.updateThrows = true;

    // The intent is still recorded on ConversationIntelligence, so losing the
    // message-level copy must not take the whole analysis with it.
    await expect(analyzeConversation("t1", "cv1")).resolves.toBeTruthy();
  });

  it("writes nothing when the classifier itself fails", async () => {
    state.classifyThrows = true;

    await analyzeConversation("t1", "cv1");

    // No intent to record. An absent key is the honest state; writing
    // "general" here would tag the message with a guess.
    expect(state.updates).toHaveLength(0);
  });

  it("writes nothing when there is no inbound message", async () => {
    state.messages = [msg({ direction: "OUTBOUND" })];

    await analyzeConversation("t1", "cv1");

    expect(state.updates).toHaveLength(0);
    expect(state.classifyCalls).toBe(0);
  });
});
