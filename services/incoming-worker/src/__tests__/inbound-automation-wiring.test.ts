/**
 * The inbound worker's order of responders, through dispatch():
 *
 *   - ★ an automation that answered the message ends it: no AI reply, no
 *     playbook routing on top (one responder per inbound)
 *   - an automation that did not answer leaves the path exactly as it was
 *   - ★ a sub-flow parked on the conversation resumes in THAT flow (it used to
 *     resume the main canvas with a node id the canvas does not have)
 *   - ★ when automations answered the first messages, the first message none
 *     answered is the one the playbook routes
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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

beforeEach(() => {
  Object.values(mocks).forEach((f) => f.mockClear());
  (prisma.conversation as any).__reset();
  S.conv = baseConv(); S.afterAutomation = null; S.messageCount = 1; S.answered = false; S.answeredBefore = false;
});

describe("★ one responder per inbound", () => {
  it("an automation answered: no AI, no routing", async () => {
    S.conv = baseConv({ handledBy: "ai_agent", assignedAiAgentId: "maya" });
    S.messageCount = 4;
    S.answered = true;
    await dispatch(JOB);
    expect(mocks.automationsForInbound).toHaveBeenCalledWith(expect.objectContaining({ messageId: "m1", message: "hello", channel: "whatsapp", contactId: "k1" }));
    expect(mocks.processAIBot).not.toHaveBeenCalled();
    expect(mocks.routeConversation).not.toHaveBeenCalled();
  });

  it("no automation answered: the AI answers as before", async () => {
    S.conv = baseConv({ handledBy: "ai_agent", assignedAiAgentId: "maya" });
    S.messageCount = 4;
    await dispatch(JOB);
    expect(mocks.processAIBot).toHaveBeenCalledWith("t1", "c1", "hello");
  });

  it("an automation assigned a person while it ran: nothing else answers", async () => {
    S.conv = baseConv({ handledBy: "ai_agent", assignedAiAgentId: "maya" });
    S.afterAutomation = baseConv({ handledBy: "human", assignedAgentId: "u1" });
    await dispatch(JOB); // a first message: routing would run next
    expect(mocks.processAIBot).not.toHaveBeenCalled();
    expect(mocks.routeConversation).not.toHaveBeenCalled();
  });

  it("a person owns the conversation: automations do not even run", async () => {
    S.conv = baseConv({ assignedAgentId: "u1", handledBy: "human" });
    await dispatch(JOB);
    expect(mocks.automationsForInbound).not.toHaveBeenCalled();
  });
});

describe("★ resume and routing", () => {
  it("a parked sub-flow resumes in that flow, not the main canvas", async () => {
    S.conv = baseConv({ handledBy: null, chatbotNodeId: "qr1", chatbotFlowId: "sub1" });
    S.messageCount = 3;
    await dispatch(JOB);
    expect(mocks.executeSubFlow).toHaveBeenCalledWith(expect.objectContaining({ flowId: "sub1", resumeNodeId: "qr1" }));
    expect(mocks.executeMainFlow).not.toHaveBeenCalled();
  });

  it("a main-canvas cursor still resumes the main canvas", async () => {
    S.conv = baseConv({ handledBy: null, chatbotNodeId: "qr1" });
    S.messageCount = 3;
    await dispatch(JOB);
    expect(mocks.executeMainFlow).toHaveBeenCalledWith(expect.objectContaining({ resumeNodeId: "qr1" }));
  });

  it("★ after automations answered the first messages, the first unanswered one is routed", async () => {
    S.messageCount = 3;
    S.answeredBefore = true;
    await dispatch(JOB);
    expect(mocks.routeConversation).toHaveBeenCalledTimes(1);
  });

  it("without that, a later message of an unrouted conversation is not routed (unchanged)", async () => {
    S.messageCount = 3;
    await dispatch(JOB);
    expect(mocks.routeConversation).not.toHaveBeenCalled();
  });

  it("the first message is routed as always", async () => {
    await dispatch(JOB);
    expect(mocks.routeConversation).toHaveBeenCalledTimes(1);
  });
});
