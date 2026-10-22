/**
 * The live WhatsApp bot path: a FAILED send must not move the conversation's
 * sort key.
 *
 * The inbox orders by `lastMessageAt`. All three writers on this path stamp
 * `status: extId ? "SENT" : "FAILED"` and then advanced the column
 * unconditionally, so a reply the customer never received demoted them below
 * everybody the bot happened to answer - on the busiest writer in the product.
 *
 * These tests pin the guard at each of the three sites separately, because each
 * one is reached by a different route and a single passing case would not prove
 * the other two.
 *
 * ★ The message double returns a FIXED `createdAt` far from now, so the tests
 * can tell the difference between "took the row's timestamp" and "took the
 * clock" - the two were indistinguishable while the code used `new Date()`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const MSG_AT = new Date("2026-03-04T05:06:07.000Z");

const H = vi.hoisted(() => {
  const v: any = vi;
  return {
    reply: { current: null as any },
    sendText: v.fn(),
    conversationUpdate: v.fn().mockResolvedValue({}),
    createMessage: v.fn(),
    publish: v.fn().mockResolvedValue(undefined),
    axiosPost: v.fn(),
  };
});

vi.mock("axios", () => ({ default: { post: H.axiosPost } }));

vi.mock("@chatcenter/shared", () => ({
  // Called at module load, so it must exist before anything else runs.
  getInternalServiceKey: () => "test-internal-key",
  recordHandover: async () => undefined,
  // The real one turns a provider error into the pair the writer persists.
  describeSendError: (err: any) => ({
    sendError: { message: String(err?.message ?? err) },
    errorMessage: String(err?.message ?? err),
  }),
  getRedis: () => ({ get: async () => null, set: async () => "OK", del: async () => 1 }),
  BUSINESS_HOURS_KEY: "business_hours",
  parseBusinessHours: () => null,
  // Open, so these tests exercise the send path rather than the closed-hours one.
  evaluateBusinessHours: () => ({ open: true }),
  describeNextOpening: () => "tomorrow at 9",
  probeUploadsDir: () => ({ ok: true, dir: "/tmp/uploads" }),
  describeUploadsProbe: () => "uploads ok",
  classifyMediaFailure: () => "download_failed",
  reportOperationalFailure: () => {},
  ERROR_CODES: new Proxy({}, { get: (_t: any, k: any) => String(k) }),
  readDurableSetting: async () => null,
  writeDurableSetting: async () => undefined,
  settingCacheKey: (t: string, k: string) => `tenant:${t}:${k}`,
  shopifyApiVersion: () => "2026-07",
  checkShopifyResponseVersion: () => ({ ok: true, served: "2026-07" }),
  metaGraphBaseUrl: (legacy?: string) => legacy || "https://graph.facebook.com/v24.0",
  stripeVersionHeader: () => ({ "Stripe-Version": "2026-02-25.clover" }),
  prisma: {
    conversation: {
      findFirst: vi.fn(async () => ({
        id: "conv1",
        tenantId: "t1",
        isHandedOver: false,
        assignedAgentId: null,
        assignedAiAgentId: "agent1",
        channel: "WHATSAPP",
        customerExternalId: "972500000000",
        createdAt: new Date(),
        channelAccount: { id: "ch1", externalId: "wa1", credentials: { accessToken: "x" } },
      })),
      findUnique: vi.fn(async () => ({ createdAt: new Date() })),
      update: H.conversationUpdate,
    },
    aIAgent: {
      findUnique: vi.fn(async () => ({
        id: "agent1",
        tenantId: "t1",
        escalationMessage: "Connecting you now.",
        maxAutonomousMessages: 10,
        maxAutonomousMinutes: 60,
        status: "ACTIVE",
      })),
    },
    message: {
      create: H.createMessage,
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([{ body: "hi" }]),
    },
    // The escalation path looks up a reach-path. Without this the real code
    // takes its catch branch, which would make this double quietly more
    // forgiving than production.
    contact: { findFirst: vi.fn(async () => ({ email: null, phone: "972500000000" })) },
    usageLog: { create: vi.fn().mockResolvedValue({}) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
  getOutboundAdapter: () => ({ sendTextMessage: H.sendText }),
  decryptCredentials: (v: any) => v,
  publishEvent: H.publish,
}));

import { processAIBot } from "../services/ai-bot.service";

/** Only the calls that make an ordering claim. The approval path also updates
 *  `handledBy` on the same model, which is not what these tests are about. */
function sortKeyWrites() {
  return H.conversationUpdate.mock.calls
    .map((c: any[]) => c[0])
    .filter((a: any) => a?.data && "lastMessageAt" in a.data);
}

beforeEach(() => {
  vi.clearAllMocks();
  H.conversationUpdate.mockResolvedValue({});
  H.createMessage.mockImplementation(async ({ data }: any) => ({
    id: "msg1",
    createdAt: MSG_AT,
    ...data,
  }));
  H.axiosPost.mockImplementation(async () => ({ data: H.reply.current }));
  H.reply.current = {
    reply: "Yes, we have it in stock.",
    escalation: null,
    awaitingApproval: null,
    toolCallLog: [],
    modelUsed: "gpt-4o-mini",
    totalTokens: 100,
  };
});

describe("ai-bot: a failed send does not move the sort key", () => {
  it("advances it from the MESSAGE's timestamp when the reply is delivered", async () => {
    H.sendText.mockResolvedValue("wamid.OK");
    await processAIBot("t1", "conv1", "do you have it?");

    const writes = sortKeyWrites();
    expect(writes).toHaveLength(1);
    // Not `new Date()`: the column and the thread must agree, because the
    // inbox cursor pages over both.
    expect(writes[0].data.lastMessageAt).toEqual(MSG_AT);
  });

  it("leaves it untouched when the reply send fails", async () => {
    H.sendText.mockResolvedValue(null);
    await processAIBot("t1", "conv1", "do you have it?");

    const created = H.createMessage.mock.calls.map((c: any[]) => c[0].data);
    expect(created.some((d: any) => d.status === "FAILED")).toBe(true);
    expect(sortKeyWrites()).toHaveLength(0);
  });

  it("leaves it untouched when an interim ack fails, and still records the row", async () => {
    H.reply.current = { ...H.reply.current, interimMessages: ["one moment, checking"] };
    // The interim fails, the real reply lands. Only the reply may claim the key.
    H.sendText.mockResolvedValueOnce(null).mockResolvedValue("wamid.REPLY");
    await processAIBot("t1", "conv1", "check stock please");

    const created = H.createMessage.mock.calls.map((c: any[]) => c[0].data);
    expect(created.some((d: any) => d.metadata?.kind === "interim_ack" && d.status === "FAILED")).toBe(true);
    const writes = sortKeyWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0].data.lastMessageAt).toEqual(MSG_AT);
  });

  it("leaves it untouched when the approval bridge-ack fails", async () => {
    H.reply.current = {
      reply: null,
      escalation: null,
      awaitingApproval: { approvalRequestId: "ar1", tool: "cancel_order", reason: "money" },
      toolCallLog: [],
      modelUsed: "gpt-4o-mini",
      totalTokens: 10,
      // the oneshot that generates the ack reads `.reply` off this same object
    };
    H.axiosPost.mockImplementation(async () => ({
      data: { ...H.reply.current, reply: "give me a sec" },
    }));
    H.sendText.mockResolvedValue(null);
    await processAIBot("t1", "conv1", "cancel my order");

    const created = H.createMessage.mock.calls.map((c: any[]) => c[0].data);
    expect(created.some((d: any) => d.metadata?.kind === "bridge_ack_for_approval" && d.status === "FAILED")).toBe(true);
    expect(sortKeyWrites()).toHaveLength(0);
  });
});
