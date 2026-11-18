/** Two customer messages a second apart get ONE reply (prod 2026-11-18, Smoovee x1maje). */
import { describe, it, expect, vi, beforeEach } from "vitest";

const MSG_AT = new Date("2026-03-04T05:06:07.000Z");

const H = vi.hoisted(() => {
  const v: any = vi;
  return {
    reply: { current: null as any },
    newest: [] as string[],
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
      // The newest inbound, call by call (the first check, then the one before the send).
      findFirst: vi.fn(async () => { const id = H.newest.length > 1 ? H.newest.shift() : H.newest[0]; return id ? { id } : null; }),
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

import { processAIBot, turnSettleMs } from "../services/ai-bot.service";


beforeEach(() => {
  vi.clearAllMocks();
  process.env.TURN_SETTLE_MS = "0";
  H.newest = [];
  H.createMessage.mockImplementation(async ({ data }: any) => ({ id: "out1", createdAt: MSG_AT, ...data }));
  H.axiosPost.mockImplementation(async () => ({ data: H.reply.current }));
  H.sendText.mockResolvedValue("wamid.OK");
  H.reply.current = { reply: "יש במלאי.", escalation: null, awaitingApproval: null, toolCallLog: [], modelUsed: "m", totalTokens: 1 };
});

describe("one reply for messages a second apart (prod 2026-11-18)", () => {
  it("★ a newer message already there: this turn is skipped, no AI call, no send", async () => {
    H.newest = ["in2"];
    const took = await processAIBot("t1", "conv1", "שאלה", null, null, "in1");
    expect(took).toBe(true);
    expect(H.axiosPost).not.toHaveBeenCalled();
    expect(H.sendText).not.toHaveBeenCalled();
  });
  it("★ overtaken while the AI worked: the reply is dropped", async () => {
    H.newest = ["in1", "in2"];
    const took = await processAIBot("t1", "conv1", "שאלה", null, null, "in1");
    expect(took).toBe(true);
    expect(H.axiosPost).toHaveBeenCalled();
    expect(H.sendText).not.toHaveBeenCalled();
  });
  it("still the newest: answered", async () => {
    H.newest = ["in1"];
    await processAIBot("t1", "conv1", "שאלה", null, null, "in1");
    expect(H.sendText).toHaveBeenCalled();
  });
  it("no message id (a flow's call): unchanged", async () => {
    H.newest = ["in9"];
    await processAIBot("t1", "conv1", "שאלה");
    expect(H.sendText).toHaveBeenCalled();
  });
  it("the settle time: 1500 by default, bounded", () => {
    expect(turnSettleMs({} as any)).toBe(1500);
    expect(turnSettleMs({ TURN_SETTLE_MS: "0" } as any)).toBe(0);
    expect(turnSettleMs({ TURN_SETTLE_MS: "99999" } as any)).toBe(1500);
  });
});
