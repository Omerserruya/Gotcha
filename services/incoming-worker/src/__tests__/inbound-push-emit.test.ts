/**
 * ★ message.inbound (mobile push, 2026-11-03): every inbound customer message
 * in a conversation a PERSON is assigned to is announced to the notifications
 * service, for the assignee's phone; never while the bot handles it.
 * Wired through dispatch(): human-assigned emits, bot-handled and unassigned
 * do not, on every channel this path carries (the website widget and the
 * Shopify chat included). The rule and the payload are tested where they
 * live, packages/shared/src/__tests__/inbound-push.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const Q = vi.hoisted(() => ({ adds: [] as any[] }));
const S = vi.hoisted(() => ({
  conv: {} as any,
  messageCount: 1,
  answered: false,
  answeredBefore: false,
  afterAutomation: null as any,
}));

const { prisma, mocks } = vi.hoisted(() => {
  const mocks = {
    automationsForInbound: vi.fn(async () => S.answered),
    automationAnsweredBefore: vi.fn(async () => S.answeredBefore),
    processAIBot: vi.fn(async () => true),
    routeConversation: vi.fn(async () => ({ handledByAI: true })),
    executeMainFlow: vi.fn(async () => ({ executed: true, halted: true, trace: [] })),
    executeSubFlow: vi.fn(async () => ({ executed: true, halted: true, trace: [] })),
  };
  let reads = 0;
  const prisma = {
    tenant: { findUnique: vi.fn(async () => ({ status: "ACTIVE" })) },
    message: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async (a: any) => ({ id: "m1", createdAt: new Date(), ...a.data })),
      count: vi.fn(async () => S.messageCount),
    },
    conversation: {
      // 1st read: the lookup; later reads: the refresh after automations ran.
      findFirst: vi.fn(async () => { reads++; return reads === 1 ? { ...S.conv } : { ...(S.afterAutomation ?? S.conv) }; }),
      create: vi.fn(),
      update: vi.fn(async () => ({})),
      __reset: () => { reads = 0; },
    },
    channelAccount: { findUnique: vi.fn(async () => ({ id: "ca1", credentials: {} })) },
    contact: { update: vi.fn(async () => ({})), updateMany: vi.fn(async () => ({ count: 1 })), findFirst: vi.fn(async () => null) },
  };
  return { prisma, mocks };
});

vi.mock("@chatcenter/shared", () => ({
  probeUploadsDir: () => ({ ok: true, dir: "/tmp/uploads" }),
  describeUploadsProbe: () => "uploads ok",
  classifyMediaFailure: () => "download_failed",
  reportOperationalFailure: () => {},
  ERROR_CODES: new Proxy({}, { get: (_t, k) => String(k) }),
  prisma,
  publishEvent: vi.fn(async () => undefined),
  isInboundExcluded: vi.fn(async () => false),
  createWorker: vi.fn(),
  analyticsQueue: { add: vi.fn() },
  outgoingMessageQueue: { add: vi.fn() },
  decryptCredentials: vi.fn(() => ({})),
  metaGraphBaseUrl: (legacy?: string) => legacy || "https://graph.facebook.com/v24.0",
  resolveContactByChannelId: vi.fn(async () => null),
  readDurableSetting: async () => null,
  writeDurableSetting: async () => undefined,
  settingCacheKey: (t: string, k: string) => `tenant:${t}:${k}`,
  shopifyApiVersion: () => "2026-07",
  checkShopifyResponseVersion: () => ({ ok: true, served: "2026-07" }),
  stripeVersionHeader: () => ({ "Stripe-Version": "2026-02-25.clover" }),
}));
vi.mock("../services/whatsapp-approval-inbound.service", () => ({ handleApprovalButtonReply: vi.fn(async () => ({ handled: false })) }));
vi.mock("../services/comment-trigger.service", () => ({ processCommentTrigger: vi.fn() }));
vi.mock("../services/ensure-contact.service", () => ({ ensureContactForInbound: vi.fn(async () => ({ id: "k1", displayName: "Dana" })) }));
vi.mock("../services/locale-detect.service", () => ({ recordDetectedLocaleIfMissing: vi.fn(async () => undefined) }));
vi.mock("../services/identity-link.service", () => ({ tryLinkIdentifierFromInbound: vi.fn(async () => undefined) }));
vi.mock("../services/automation-runner.service", () => ({
  automationsForInbound: mocks.automationsForInbound,
  automationAnsweredBefore: mocks.automationAnsweredBefore,
}));
vi.mock("../services/ai-bot.service", () => ({ processAIBot: mocks.processAIBot }));
vi.mock("../services/routing.service", () => ({ routeConversation: mocks.routeConversation }));
vi.mock("../services/flow-executor.service", () => ({ executeMainFlow: mocks.executeMainFlow, executeSubFlow: mocks.executeSubFlow }));

vi.mock("bullmq", () => ({
  Queue: class { name: string; constructor(name: string) { this.name = name; } add = async (name: string, data: any, opts: any) => { Q.adds.push({ queue: this.name, name, data, opts }); return { id: "j" }; } },
}));

import { dispatch } from "../workers/incoming.worker";

const JOB = {
  name: "process",
  data: {
    tenantId: "t1", channel: "WHATSAPP", channelAccountId: "ca1",
    normalizedMessage: { externalMessageId: "wamid.1", senderId: "9725", timestamp: new Date().toISOString(), contentType: "text", body: "hello", messageType: "text" },
  },
} as any;

const baseConv = (o: any = {}) => ({
  id: "c1", tenantId: "t1", channel: "WHATSAPP", customerExternalId: "9725", status: "OPEN",
  assignedAgentId: null, isHandedOver: false, departmentId: null, handledBy: null, assignedAiAgentId: null,
  chatbotNodeId: null, chatbotFlowId: null, automationRunId: null, flowExpiresAt: null, ...o,
});

const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  Object.values(mocks).forEach((f) => f.mockClear());
  (prisma.conversation as any).__reset();
  S.conv = baseConv(); S.afterAutomation = null; S.messageCount = 4; S.answered = false; S.answeredBefore = false;
  Q.adds = [];
});

describe("★ through dispatch()", () => {
  const inbound = () => Q.adds.filter((a) => a.name === "message.inbound");

  it("a human-assigned conversation: the assignee is told, the bot does not answer", async () => {
    S.conv = baseConv({ assignedAgentId: "matan", isHandedOver: true, handledBy: "human", customerName: "Omer" });
    await dispatch(JOB);
    await flush();
    expect(inbound()).toHaveLength(1);
    expect(inbound()[0].data.data).toMatchObject({ conversationId: "c1", assignedAgentId: "matan", messageId: "m1", preview: "hello", channel: "WHATSAPP", customerName: "Omer" });
    expect(mocks.processAIBot).not.toHaveBeenCalled();
  });

  it("the bot handling it: no event, the bot answers", async () => {
    S.conv = baseConv({ handledBy: "ai_agent", assignedAiAgentId: "maya" });
    await dispatch(JOB);
    await flush();
    expect(inbound()).toHaveLength(0);
    expect(mocks.processAIBot).toHaveBeenCalled();
  });

  it("the website widget and the Shopify chat go through this same path, and emit too", async () => {
    for (const channel of ["WEBCHAT", "SHOPIFY_LIVE_CHAT"]) {
      Q.adds = [];
      (prisma.conversation as any).__reset();
      S.conv = baseConv({ channel, assignedAgentId: "matan", isHandedOver: true, handledBy: "human", customerName: "Shopper" });
      await dispatch({ ...JOB, data: { ...JOB.data, channel } });
      await flush();
      expect(inbound().map((a) => a.data.data.channel), channel).toEqual([channel]);
    }
  });

  it("handed over, nobody assigned (a person replied from the queue): emitted for the team, the bot silent", async () => {
    S.conv = baseConv({ isHandedOver: true, handledBy: "human", departmentId: "sales" });
    await dispatch(JOB);
    await flush();
    expect(inbound()).toHaveLength(1);
    expect(inbound()[0].data).toMatchObject({ departmentId: "sales", data: { conversationId: "c1", assignedAgentId: null } });
    expect(mocks.processAIBot).not.toHaveBeenCalled();
  });

  it("the bot handling it with nobody assigned: no event", async () => {
    S.conv = baseConv({ handledBy: "ai_agent", assignedAiAgentId: "maya", isHandedOver: false });
    await dispatch(JOB);
    await flush();
    expect(inbound()).toHaveLength(0);
  });
});
