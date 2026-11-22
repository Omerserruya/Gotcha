/**
 * Dev 2026-11-22: the inline label timed out on a brand-new conversation and the old ai-bot path answered a
 * personal message. The label now lands seconds later (the classification is no longer thrown away), and
 * the bot reads it again at the moment it acts: no reply, no "one moment", no escalation on a hidden
 * conversation. The reply engine's replies are sent from the same place (behind /api/ai-bot/reply).
 */
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
    hidden: false,
  };
});

vi.mock("axios", () => ({ default: { post: H.axiosPost } }));
vi.mock("@chatcenter/shared/src/lib/relevance-hidden", () => ({
  isConversationHidden: vi.fn(async () => H.hidden),
  logHiddenSkip: vi.fn(),
}));

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

import { processAIBot, sendHoldingMessage } from "../services/ai-bot.service";
import { isConversationHidden } from "@chatcenter/shared/src/lib/relevance-hidden";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.TURN_SETTLE_MS = "0";
  H.newest = [];
  H.hidden = false;
  H.createMessage.mockImplementation(async ({ data }: any) => ({ id: "out1", createdAt: MSG_AT, ...data }));
  H.axiosPost.mockImplementation(async () => ({ data: H.reply.current }));
  H.sendText.mockResolvedValue("wamid.OK");
  H.reply.current = { reply: "היי! אנחנו חנות בגדים.", escalation: null, awaitingApproval: null, toolCallLog: [], modelUsed: "m", totalTokens: 1 };
});

describe("the bot reads the label at the moment it acts", () => {
  it("★ labelled hidden while the AI worked: the reply is dropped, nothing is sent", async () => {
    H.hidden = true;
    const took = await processAIBot("t1", "conv1", "נתראה אצל אמא");
    expect(took).toBe(true);
    expect(H.axiosPost).toHaveBeenCalled();
    expect(H.sendText).not.toHaveBeenCalled();
    expect(isConversationHidden).toHaveBeenCalledWith("t1", "conv1", expect.anything());
  });

  it("not hidden: answered as before", async () => {
    await processAIBot("t1", "conv1", "יש לכם במלאי?");
    expect(H.sendText).toHaveBeenCalledTimes(1);
  });

  it("★ the AI failed on a hidden conversation: no handoff line, no escalation", async () => {
    H.hidden = true;
    H.axiosPost.mockRejectedValue(Object.assign(new Error("timeout"), { response: { status: 500, data: {} } }));
    await processAIBot("t1", "conv1", "נתראה אצל אמא");
    expect(H.sendText).not.toHaveBeenCalled();
    expect(H.conversationUpdate).not.toHaveBeenCalled();
  });

  it("★ the 'one moment' holding message is not sent on a hidden conversation", async () => {
    H.hidden = true;
    await sendHoldingMessage("t1", "conv1", { channel: "WHATSAPP", channelAccountId: "ch1", recipientExternalId: "972500000000", credentials: {}, externalId: "wa1" }, "נתראה");
    expect(H.sendText).not.toHaveBeenCalled();
    expect(H.createMessage).not.toHaveBeenCalled();
  });
});
