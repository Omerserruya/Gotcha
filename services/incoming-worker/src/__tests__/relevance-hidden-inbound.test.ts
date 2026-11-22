/**
 * A hidden conversation gets NO automation on its inbound (2026-11-22, Omer: a business number that is also
 * used personally). The label comes from relevanceBeforeDispatch (its own test: relevance-inline.test.ts);
 * here, through dispatch(), every responder and push after it is skipped, and the message is still stored.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const S = vi.hoisted(() => ({
  conv: {} as any,
  messageCount: 1,
  answered: false,
  answeredBefore: false,
  afterAutomation: null as any,
  hidden: false,
}));

const { prisma, mocks } = vi.hoisted(() => {
  const mocks = {
    automationsForInbound: vi.fn(async () => S.answered),
    automationAnsweredBefore: vi.fn(async () => S.answeredBefore),
    processAIBot: vi.fn(async () => true),
    routeConversation: vi.fn(async () => ({ handledByAI: true })),
    executeMainFlow: vi.fn(async () => ({ executed: true, halted: true, trace: [] })),
    executeSubFlow: vi.fn(async () => ({ executed: true, halted: true, trace: [] })),
    relevanceBeforeDispatch: vi.fn(async () => ({ hidden: S.hidden, outcome: S.hidden ? "labelled" : "no_label", category: S.hidden ? "personal" : null, ms: 1 })),
    emitInboundMessage: vi.fn(() => true),
    tryLinkIdentifierFromInbound: vi.fn(async () => undefined),
    interceptOptOutReply: vi.fn(async () => false),
    handleUndeliverable: vi.fn(async () => false),
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
  logHiddenSkip: vi.fn(),
}));
vi.mock("../services/whatsapp-approval-inbound.service", () => ({ handleApprovalButtonReply: vi.fn(async () => ({ handled: false })) }));
vi.mock("../services/comment-trigger.service", () => ({ processCommentTrigger: vi.fn() }));
vi.mock("../services/ensure-contact.service", () => ({ ensureContactForInbound: vi.fn(async () => ({ id: "k1", displayName: "Dana" })) }));
vi.mock("../services/locale-detect.service", () => ({ recordDetectedLocaleIfMissing: vi.fn(async () => undefined) }));
vi.mock("../services/identity-link.service", () => ({ tryLinkIdentifierFromInbound: mocks.tryLinkIdentifierFromInbound }));
vi.mock("../services/relevance-inline.service", () => ({ relevanceBeforeDispatch: mocks.relevanceBeforeDispatch }));
vi.mock("@chatcenter/shared/src/lib/notifications/inbound-push", () => ({ emitInboundMessage: mocks.emitInboundMessage }));
vi.mock("../services/marketing-optout.service", () => ({ interceptOptOutReply: mocks.interceptOptOutReply }));
vi.mock("../services/undeliverable-message.service", () => ({ handleUndeliverable: mocks.handleUndeliverable }));
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

const responders = () => ({
  automations: mocks.automationsForInbound.mock.calls.length,
  ai: mocks.processAIBot.mock.calls.length,
  routing: mocks.routeConversation.mock.calls.length,
  mainFlow: mocks.executeMainFlow.mock.calls.length,
  subFlow: mocks.executeSubFlow.mock.calls.length,
  push: mocks.emitInboundMessage.mock.calls.length,
  identity: mocks.tryLinkIdentifierFromInbound.mock.calls.length,
  undeliverable: mocks.handleUndeliverable.mock.calls.length,
});
const NONE = { automations: 0, ai: 0, routing: 0, mainFlow: 0, subFlow: 0, push: 0, identity: 0, undeliverable: 0 };
const settle = () => new Promise((r) => setTimeout(r, 5));

beforeEach(() => {
  Object.values(mocks).forEach((f: any) => f.mockClear());
  (prisma.conversation as any).__reset();
  prisma.message.create.mockClear();
  S.conv = baseConv(); S.afterAutomation = null; S.messageCount = 1; S.answered = false; S.answeredBefore = false; S.hidden = false;
});

describe("a hidden conversation: the message is stored, nothing acts on it", () => {
  it("a first message: no automation, no routing or auto-assignment, no AI, no push, no CRM identity link", async () => {
    S.hidden = true;
    await dispatch(JOB);
    await settle();
    expect(mocks.relevanceBeforeDispatch).toHaveBeenCalledWith("t1", expect.objectContaining({ id: "c1" }));
    expect(prisma.message.create).toHaveBeenCalledTimes(1);
    expect(prisma.message.create.mock.calls[0][0].data).toMatchObject({ direction: "INBOUND", body: "hello" });
    expect(responders()).toEqual(NONE);
  });

  it("an AI-held conversation: the AI does not answer", async () => {
    S.hidden = true;
    S.conv = baseConv({ handledBy: "ai_agent", assignedAiAgentId: "maya" });
    S.messageCount = 4;
    await dispatch(JOB);
    await settle();
    expect(responders()).toEqual(NONE);
  });

  it("a parked flow does not resume", async () => {
    S.hidden = true;
    S.conv = baseConv({ chatbotNodeId: "qr1", chatbotFlowId: "sub1" });
    S.messageCount = 3;
    await dispatch(JOB);
    expect(responders()).toEqual(NONE);
  });

  it("a person's conversation: their phone is not pushed", async () => {
    S.hidden = true;
    S.conv = baseConv({ assignedAgentId: "u1", handledBy: "human" });
    await dispatch(JOB);
    expect(responders()).toEqual(NONE);
  });

  it("a STOP is still recorded, silently: the opt-out runs with silent true", async () => {
    S.hidden = true;
    await dispatch(JOB);
    expect(mocks.interceptOptOutReply).toHaveBeenCalledWith(expect.objectContaining({ silent: true, conversationId: "c1" }));
  });

  it("the label is made before anything else acts: before the identity link, the push and the responders", async () => {
    S.conv = baseConv({ assignedAgentId: "u1", handledBy: "human" });
    await dispatch(JOB);
    await settle();
    const at = mocks.relevanceBeforeDispatch.mock.invocationCallOrder[0];
    expect(at).toBeLessThan(mocks.tryLinkIdentifierFromInbound.mock.invocationCallOrder[0]);
    expect(at).toBeLessThan(mocks.emitInboundMessage.mock.invocationCallOrder[0]);
    expect(at).toBeLessThan(mocks.interceptOptOutReply.mock.invocationCallOrder[0]);
  });
});

describe("not hidden: the path is as before", () => {
  it("a first message is routed, linked and offered to the opt-out check with silent false", async () => {
    await dispatch(JOB);
    await settle();
    expect(mocks.routeConversation).toHaveBeenCalledTimes(1);
    expect(mocks.tryLinkIdentifierFromInbound).toHaveBeenCalledTimes(1);
    expect(mocks.handleUndeliverable).toHaveBeenCalledTimes(1);
    expect(mocks.interceptOptOutReply).toHaveBeenCalledWith(expect.objectContaining({ silent: false }));
  });

  it("an AI-held conversation is answered; a person's is pushed to their phone", async () => {
    S.conv = baseConv({ handledBy: "ai_agent", assignedAiAgentId: "maya" });
    S.messageCount = 4;
    await dispatch(JOB);
    expect(mocks.processAIBot).toHaveBeenCalledTimes(1);
    (prisma.conversation as any).__reset();
    S.conv = baseConv({ assignedAgentId: "u1", handledBy: "human" });
    await dispatch(JOB);
    expect(mocks.emitInboundMessage).toHaveBeenCalled();
  });
});
