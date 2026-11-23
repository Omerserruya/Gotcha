/**
 * Reply engine v2 hand-overs (Omer 2026-11-23): the customer gets the engine's line word for word ("מעבירים אותך עכשיו
 * לטיפול של נציג אנושי שימשיך מכאן.", after what it really answered), not a line the worker writes itself, and the team
 * is told (conversation.escalated). Before, a v2 hand-over went out with notify off: no admin heard of it.
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
    emitEscalated: v.fn(),
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
  assignSoleMemberOnHandoff: async () => null,
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
vi.mock("../services/notifications-emit", () => ({ emitEscalated: H.emitEscalated }));

import { processAIBot } from "../services/ai-bot.service";

const HAND = "מעבירים אותך עכשיו לטיפול של נציג אנושי שימשיך מכאן.";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.TURN_SETTLE_MS = "0";
  H.newest = [];
  H.hidden = false;
  H.createMessage.mockImplementation(async ({ data }: any) => ({ id: "out1", createdAt: MSG_AT, ...data }));
  H.sendText.mockResolvedValue("wamid.OK");
});

const turnReturns = (escalation: any) => {
  H.axiosPost.mockImplementation(async (url: string) => (/\/oneshot/.test(String(url))
    ? { data: { reply: "GENERATED LINE" } }
    : { data: { reply: escalation?.customerLine ?? null, escalation, awaitingApproval: null, toolCallLog: [], modelUsed: "m", totalTokens: 1 } }));
};

describe("a v2 hand-over: the engine's own line, and the team is told", () => {
  it("★ the exact line goes out, no generated one, and conversation.escalated fires", async () => {
    const line = `העובי הוא 2.2-2.5 מ"מ. ${HAND}`;
    turnReturns({ reason: "ai_handoff:not answered after looking: עמידות לשמן", priority: "medium", summary: "x", customerLine: line, announce: true });
    await processAIBot("t1", "conv1", "והוא עמיד לשמן?");
    expect(H.sendText).toHaveBeenCalledTimes(1);
    expect(H.sendText.mock.calls[0][3]).toBe(line);
    expect(H.axiosPost.mock.calls.some((c: any[]) => /\/oneshot/.test(String(c[0])))).toBe(false);
    expect(H.emitEscalated).toHaveBeenCalledTimes(1);
    expect(H.emitEscalated.mock.calls[0][0]).toMatchObject({ tenantId: "t1", conversationId: "conv1", reason: "ai_handoff:not answered after looking: עמידות לשמן" });
  });

  it("an escalation without them (legacy, an older ai image) is handled as before: a generated line, no second announcement", async () => {
    turnReturns({ reason: "ai_decided", priority: "medium", summary: "x" });
    await processAIBot("t1", "conv1", "יש עדכון על ההזמנה?");
    expect(H.sendText).toHaveBeenCalledTimes(1);
    expect(H.sendText.mock.calls[0][3]).not.toBe(HAND);
    expect(H.emitEscalated).not.toHaveBeenCalled();
  });
});
