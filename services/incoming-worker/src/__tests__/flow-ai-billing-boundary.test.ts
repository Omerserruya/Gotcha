/**
 * Where AI billing may and may not be checked during a flow run.
 *
 * The invariant under test: a tenant with ZERO AI credits must be able to run
 * every deterministic node in a flow - send_message, quick reply, condition,
 * wait - and must only meet the billing gate at the exact node that transfers
 * control to an AI employee.
 *
 * The billing gate itself (`checkAiAllowed`) lives in services/ai and is only
 * reachable from this service through `processAIBot`, which POSTs to
 * `/api/ai-bot/reply`. So "processAIBot was not called" is exactly equivalent
 * to "the billing gate was not reached", and that is what these tests assert.
 *
 * Graph under test, as specified:
 *
 *   channel_entry -> send_message -> quick_reply -> condition
 *                 -> send_message -> AI employee -> end
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { processAIBot } = vi.hoisted(() => ({ processAIBot: vi.fn() }));
vi.mock("../services/ai-bot.service", () => ({ processAIBot }));
vi.mock("../services/identity-link.service", () => ({
  tryLinkIdentifierFromInbound: vi.fn(),
}));

const { conversation, flowCanvas, chatbotFlow, message, sendTextMessage } = vi.hoisted(() => ({
  conversation: { update: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn() },
  flowCanvas: { findUnique: vi.fn() },
  chatbotFlow: { findFirst: vi.fn(), update: vi.fn() },
  message: { create: vi.fn() },
  sendTextMessage: vi.fn(),
}));

vi.mock("@chatcenter/shared", () => ({
  readDurableSetting: async () => null,
  writeDurableSetting: async () => undefined,
  settingCacheKey: (t: string, k: string) => `tenant:${t}:${k}`,
  shopifyApiVersion: () => "2026-07",
  checkShopifyResponseVersion: () => ({ ok: true, served: "2026-07" }),
  metaGraphBaseUrl: (legacy?: string) => legacy || "https://graph.facebook.com/v24.0",
  stripeVersionHeader: () => ({ "Stripe-Version": "2026-02-25.clover" }),
  prisma: {
    conversation,
    flowCanvas,
    chatbotFlow,
    message,
    contact: { findFirst: vi.fn(), update: vi.fn() },
    messageTemplate: { findFirst: vi.fn() },
  },
  getOutboundAdapter: vi.fn(() => ({
    sendTextMessage,
    sendInteractiveMessage: sendTextMessage,
  })),
  decryptCredentials: vi.fn(() => ({})),
  publishEvent: vi.fn().mockResolvedValue(undefined),
  flowResumeQueue: { add: vi.fn().mockResolvedValue(undefined) },
  describeSendError: () => ({ sendError: null, errorMessage: null }),
  safeFetch: vi.fn(),
}));

import { executeMainFlow } from "../services/flow-executor.service";

const TENANT = "tenant-1";
const CONV = "conv-1";

const NODES = [
  { id: "n1", type: "channel_entry", data: { channel: "whatsapp" } },
  { id: "n2", type: "send_message_text", data: { text: "First deterministic message" } },
  { id: "n3", type: "send_message_quick_reply", data: { text: "Pick one", buttons: [{ id: "yes", title: "Yes" }] } },
  { id: "n4", type: "condition_group", data: { conditions: [] } },
  { id: "n5", type: "send_message_text", data: { text: "Second deterministic message" } },
  { id: "n6", type: "route_target", data: { routeType: "agent", targetId: "ai-employee-1" } },
  { id: "n7", type: "end", data: { endKind: "wait_for_reply" } },
];

const EDGES = [
  { id: "e1", source: "n1", target: "n2" },
  { id: "e2", source: "n2", target: "n3" },
  { id: "e3", source: "n3", target: "n4", sourceHandle: "yes" },
  { id: "e4", source: "n4", target: "n5", sourceHandle: "true" },
  { id: "e5", source: "n5", target: "n6" },
  { id: "e6", source: "n6", target: "n7" },
];

/** Every handledBy value written to the conversation, in order. */
function ownershipWrites() {
  return conversation.update.mock.calls
    .map((c: any[]) => c[0]?.data?.handledBy)
    .filter((v: unknown) => v !== undefined);
}

function sentBodies() {
  return sendTextMessage.mock.calls.map((c: any[]) => c[3]);
}

beforeEach(() => {
  vi.clearAllMocks();
  flowCanvas.findUnique.mockResolvedValue({ tenantId: TENANT, nodes: NODES, edges: EDGES });
  conversation.findFirst.mockResolvedValue({
    id: CONV,
    tenantId: TENANT,
    channel: "WHATSAPP",
    customerExternalId: "972500000000",
    flowVariables: {},
    channelAccount: { externalId: "wa-1", credentials: {} },
  });
  conversation.update.mockResolvedValue({});
  message.create.mockResolvedValue({ id: "m1", createdAt: new Date() });
  sendTextMessage.mockResolvedValue("wamid.1");
  // The tenant has ZERO AI credits for the entire test. Nothing in the
  // deterministic half of the graph is allowed to care.
  processAIBot.mockResolvedValue(true);
});

describe("zero AI credits: deterministic nodes run, billing is not consulted", () => {
  it("runs entry -> send_message -> quick reply without ever reaching the AI boundary", async () => {
    const res = await executeMainFlow({
      tenantId: TENANT,
      conversationId: CONV,
      message: "hi",
      channel: "whatsapp",
    });

    // 1. First send_message executed.
    expect(sentBodies()).toContain("First deterministic message");
    // 2. The quick reply paused the flow, so the run stopped there.
    expect(res.halted).toBe(true);
    // 5. No AI billing block has happened yet - the gate was never reachable.
    expect(processAIBot).not.toHaveBeenCalled();
    // 8. Ownership is still the flow's.
    expect(ownershipWrites()).not.toContain("ai_agent");
    expect(ownershipWrites()).toContain("flow");
  });

  it("resumes on the quick reply and runs condition + second send, still with no AI", async () => {
    // Resume exactly as incoming.worker does for a handledBy=flow conversation
    // paused at a quick reply: the reply payload picks the edge.
    const res = await executeMainFlow({
      tenantId: TENANT,
      conversationId: CONV,
      message: "yes",
      channel: "whatsapp",
      resumeNodeId: "n3",
    });

    // 3 + 4. Condition executed, second send_message executed.
    expect(res.trace.some((t: any) => t.type === "condition_group")).toBe(true);
    expect(sentBodies()).toContain("Second deterministic message");
    // 6. Only at the AI employee node is the boundary crossed - exactly once.
    expect(processAIBot).toHaveBeenCalledTimes(1);
    expect(processAIBot).toHaveBeenCalledWith(TENANT, CONV, "yes", "ai-employee-1");
  });

  it("does not consult billing merely because an AI node exists later in the graph", async () => {
    // Same graph, but the condition routes AWAY from the AI node. The AI
    // employee is still present in the canvas and must stay irrelevant.
    flowCanvas.findUnique.mockResolvedValue({
      tenantId: TENANT,
      nodes: NODES,
      edges: [
        ...EDGES.filter((e) => e.id !== "e4"),
        { id: "e4b", source: "n4", target: "n7", sourceHandle: "true" },
      ],
    });

    await executeMainFlow({
      tenantId: TENANT,
      conversationId: CONV,
      message: "yes",
      channel: "whatsapp",
      resumeNodeId: "n3",
    });

    expect(processAIBot).not.toHaveBeenCalled();
    expect(ownershipWrites()).not.toContain("ai_agent");
  });
});

describe("sub-flow ownership stomp (the reported production state)", () => {
  /**
   * Main flow routes into a SUB-flow, and the AI employee node lives inside
   * that sub-flow. This is the shape that produces the state actually
   * observed: `handledBy = "flow"` on a conversation whose turn nonetheless
   * crossed the AI billing boundary and escalated.
   */
  const MAIN = [
    { id: "m1", type: "channel_entry", data: { channel: "whatsapp" } },
    { id: "m2", type: "send_message_text", data: { text: "First deterministic message" } },
    { id: "m3", type: "route_target", data: { routeType: "flow", targetId: "sub-1" } },
  ];
  const MAIN_EDGES = [
    { id: "me1", source: "m1", target: "m2" },
    { id: "me2", source: "m2", target: "m3" },
  ];
  const SUB = [
    { id: "s1", type: "start", data: {} },
    { id: "s2", type: "send_message_text", data: { text: "Sub-flow deterministic message" } },
    { id: "s3", type: "route_target", data: { routeType: "agent", targetId: "ai-employee-1" } },
  ];
  const SUB_EDGES = [
    { id: "se1", source: "s1", target: "s2" },
    { id: "se2", source: "s2", target: "s3" },
  ];

  beforeEach(() => {
    flowCanvas.findUnique.mockResolvedValue({ tenantId: TENANT, nodes: MAIN, edges: MAIN_EDGES });
    chatbotFlow.findFirst.mockResolvedValue({
      id: "sub-1",
      tenantId: TENANT,
      isActive: true,
      nodes: SUB,
      edges: SUB_EDGES,
    });
    chatbotFlow.update.mockResolvedValue({});
  });

  it("does not restore flow ownership after the sub-flow crossed the AI boundary", async () => {
    await executeMainFlow({
      tenantId: TENANT,
      conversationId: CONV,
      message: "hi",
      channel: "whatsapp",
    });

    // The AI boundary WAS crossed - with zero credits this is the turn that
    // reaches checkAiAllowed and escalates.
    expect(processAIBot).toHaveBeenCalledTimes(1);

    // The parent must not overwrite that with "flow". Leaving it as "flow"
    // is what made incoming.worker re-walk the same graph on every later
    // inbound and cross the AI boundary again each time.
    const writes = ownershipWrites();
    expect(writes[writes.length - 1]).not.toBe("flow");
    expect(writes[writes.length - 1]).toBe("ai_agent");
  });

  it("still restores flow ownership when the sub-flow made no ownership decision", async () => {
    // A sub-flow that only sends messages leaves the decision open, and the
    // parent is right to record the conversation as flow-driven.
    chatbotFlow.findFirst.mockResolvedValue({
      id: "sub-1",
      tenantId: TENANT,
      isActive: true,
      nodes: [
        { id: "s1", type: "start", data: {} },
        { id: "s2", type: "send_message_text", data: { text: "Sub-flow deterministic message" } },
      ],
      edges: [{ id: "se1", source: "s1", target: "s2" }],
    });

    await executeMainFlow({
      tenantId: TENANT,
      conversationId: CONV,
      message: "hi",
      channel: "whatsapp",
    });

    expect(processAIBot).not.toHaveBeenCalled();
    expect(ownershipWrites()).toContain("flow");
  });
});

describe("ownership at the AI transfer boundary", () => {
  it("does not record AI ownership for a turn the AI refused", async () => {
    // Exactly how an exhausted wallet fails: the AI service answers with a
    // billing escalation, escalateToHuman hands the conversation to a person
    // and sets isHandedOver. Ownership must not end up as ai_agent - the AI
    // employee never took this turn.
    let handedOver = false;
    processAIBot.mockImplementation(async () => {
      handedOver = true; // stands in for escalateToHuman's write
      return true; // processAIBot returns true even when it escalates
    });
    conversation.findFirst.mockImplementation(async () => ({
      id: CONV,
      tenantId: TENANT,
      channel: "WHATSAPP",
      customerExternalId: "972500000000",
      flowVariables: {},
      channelAccount: { externalId: "wa-1", credentials: {} },
      isHandedOver: handedOver,
    }));

    await executeMainFlow({
      tenantId: TENANT,
      conversationId: CONV,
      message: "yes",
      channel: "whatsapp",
      resumeNodeId: "n3",
    });

    expect(processAIBot).toHaveBeenCalledTimes(1);
    const writes = ownershipWrites();
    expect(
      writes,
      `a refused AI turn was recorded as AI-owned: ${JSON.stringify(writes)}`,
    ).not.toContain("ai_agent");
  });

  it("does record AI ownership once the employee actually takes the turn", async () => {
    await executeMainFlow({
      tenantId: TENANT,
      conversationId: CONV,
      message: "yes",
      channel: "whatsapp",
      resumeNodeId: "n3",
    });

    expect(ownershipWrites()).toContain("ai_agent");
  });
});
