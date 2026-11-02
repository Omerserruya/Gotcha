/**
 * ★ message.inbound (mobile push, 2026-11-03): every inbound customer message
 * in a conversation a PERSON is assigned to is announced to the notifications
 * service, for the assignee's phone; never while the bot handles it.
 *   - the rule itself (assignee set, handledBy not the bot's)
 *   - the payload: conversationId, assignedAgentId, preview, channel,
 *     customerName (and messageId, which keeps the dedup from eating repeats)
 *   - wired through dispatch(): human-assigned emits, bot-handled and
 *     unassigned do not
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
import { emitInboundMessage, inboundPreview, shouldEmitInbound } from "../services/notifications-emit";

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

describe("★ who is told", () => {
  it("a person assigned and the bot not driving: yes", () => {
    expect(shouldEmitInbound({ assignedAgentId: "matan", handledBy: "human" })).toBe(true);
    expect(shouldEmitInbound({ assignedAgentId: "matan", handledBy: null })).toBe(true);
  });
  it("no assignee: no (the recipient IS the assignee)", () => {
    expect(shouldEmitInbound({ assignedAgentId: null, handledBy: "human" })).toBe(false);
  });
  it("the bot, a flow, a pending approval or the sandbox driving: no, even with an assignee left on the row", () => {
    for (const handledBy of ["ai_agent", "awaiting_approval", "flow", "sandbox"]) {
      expect(shouldEmitInbound({ assignedAgentId: "matan", handledBy }), handledBy).toBe(false);
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

  it("refused: nothing queued", async () => {
    expect(emitInboundMessage({ tenantId: "t1", conversation: { id: "c1", assignedAgentId: "matan", handledBy: "ai_agent" }, messageId: "m1", body: "hi", messageType: "text", channel: "WHATSAPP" })).toBe(false);
    await flush();
    expect(Q.adds).toHaveLength(0);
  });
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

  it("unassigned and waiting for a person: no message.inbound (nobody to send it to)", async () => {
    S.conv = baseConv({ isHandedOver: true, handledBy: "human" });
    await dispatch(JOB);
    await flush();
    expect(inbound()).toHaveLength(0);
  });
});
