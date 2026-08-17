import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Lost conversations.
 *
 * A flow that halts deliberately always leaves a disposition: a paused node
 * parks a cursor, `route_target` dispatches, an End node closes or hands off.
 * Three exits leave nothing - the walk runs off a node with no outgoing edge,
 * an edge points at a node that is gone, or the loop guard trips.
 *
 * Those used to return and touch nothing, so the row kept `handledBy: "flow"`
 * with no cursor. That reads as "an automation is driving this" to every
 * consumer, and the inbox list EXCLUDES automated conversations by default -
 * so the conversation disappeared from every human queue while nothing was
 * driving it, and the customer's next message arrived to no one.
 *
 * Now every one of them defaults to a human.
 */

const { processAIBot } = vi.hoisted(() => ({ processAIBot: vi.fn() }));
vi.mock("../services/ai-bot.service", () => ({ processAIBot }));
vi.mock("../services/identity-link.service", () => ({
  tryLinkIdentifierFromInbound: vi.fn(),
}));

const { conversation, flowCanvas, chatbotFlow, message, sendTextMessage, publishEvent } = vi.hoisted(() => ({
  conversation: { update: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn() },
  flowCanvas: { findUnique: vi.fn() },
  chatbotFlow: { findFirst: vi.fn(), update: vi.fn() },
  message: { create: vi.fn() },
  sendTextMessage: vi.fn(),
  publishEvent: vi.fn().mockResolvedValue(undefined),
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
  publishEvent,
  flowResumeQueue: { add: vi.fn().mockResolvedValue(undefined) },
  describeSendError: () => ({ sendError: null, errorMessage: null }),
  safeFetch: vi.fn(),
}));

import { executeMainFlow } from "../services/flow-executor.service";

const TENANT = "tenant-1";
const CONV = "conv-1";
const ENTRY = { id: "e0", type: "channel_entry", data: { channel: "whatsapp" } };
const MSG = { id: "a1", type: "send_message_text", data: { text: "thanks!" } };

/** The rescue write, if it happened. */
function handoffUpdate() {
  return conversation.update.mock.calls
    .map((c: any[]) => c[0])
    .find((a: any) => a.data?.handledBy === "human");
}

function systemDivider() {
  return message.create.mock.calls
    .map((c: any[]) => c[0].data)
    .find((d: any) => d?.metadata?.systemEvent === "flow_ended_handoff");
}

const run = () => executeMainFlow({ tenantId: TENANT, conversationId: CONV, message: "hi", channel: "whatsapp" });

beforeEach(() => {
  vi.clearAllMocks();
  conversation.findFirst.mockResolvedValue({
    id: CONV, tenantId: TENANT, channel: "WHATSAPP", customerExternalId: "972500000000",
    flowVariables: {}, channelAccount: { externalId: "wa-1", credentials: {} }, isHandedOver: false,
  });
  // The state a flow-driven conversation is in mid-walk.
  conversation.findUnique.mockResolvedValue({
    status: "OPEN", handledBy: "flow", isHandedOver: false, assignedAgentId: null,
  });
  conversation.update.mockResolvedValue({});
  message.create.mockResolvedValue({ id: "m1", createdAt: new Date() });
  sendTextMessage.mockResolvedValue("wamid.1");
});

describe("a flow that ends with nothing wired after it", () => {
  beforeEach(() => {
    flowCanvas.findUnique.mockResolvedValue({
      tenantId: TENANT,
      nodes: [ENTRY, MSG],
      edges: [{ id: "x1", source: "e0", target: "a1" }], // a1 has no exit
    });
  });

  it("hands the conversation to a human instead of stranding it", async () => {
    const res = await run();

    expect(res.reason).toBe("no_outgoing_edge");
    expect(handoffUpdate()?.data).toMatchObject({
      status: "WAITING",
      handledBy: "human",
      chatbotFlowId: null,
      chatbotNodeId: null,
    });
  });

  it("clears the flow cursor so the next inbound is not walked back into the graph", async () => {
    await run();

    expect(handoffUpdate()?.data.chatbotNodeId).toBeNull();
    expect(handoffUpdate()?.data.chatbotFlowId).toBeNull();
  });

  it("records WHY on the timeline - the divider is where the authoring gap surfaces", async () => {
    await run();

    expect(systemDivider()?.metadata).toMatchObject({
      systemEvent: "flow_ended_handoff",
      flowEndReason: "no_outgoing_edge",
    });
    // Message.channel is the ChannelType enum; ctx.channel is lowercased for
    // graph comparisons. Writing the lowercase form is a hard Prisma reject,
    // which would turn the rescue into the failure it exists to prevent.
    expect(systemDivider()?.channel).toBe("WHATSAPP");
  });

  it("tells the inbox, so the row moves without a refresh", async () => {
    await run();

    expect(publishEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "conversation:updated",
      data: expect.objectContaining({ status: "WAITING", handledBy: "human" }),
    }));
  });

  it("still delivers everything the flow did send before it ran out of graph", async () => {
    await run();
    expect(sendTextMessage.mock.calls.map((c: any[]) => c[3])).toEqual(["thanks!"]);
  });
});

describe("a flow whose edge points at a node that is gone", () => {
  it("hands off rather than halting silently", async () => {
    flowCanvas.findUnique.mockResolvedValue({
      tenantId: TENANT,
      nodes: [ENTRY, MSG],
      edges: [{ id: "x1", source: "e0", target: "a1" }, { id: "x2", source: "a1", target: "deleted-node" }],
    });

    await run();

    expect(handoffUpdate()?.data).toMatchObject({ status: "WAITING", handledBy: "human" });
    expect(systemDivider()?.metadata.flowEndReason).toBe("node_not_found");
    expect(systemDivider()?.metadata.flowNodeId).toBe("deleted-node");
  });
});

describe("a flow that loops back on itself", () => {
  it("hands off when the loop guard trips", async () => {
    flowCanvas.findUnique.mockResolvedValue({
      tenantId: TENANT,
      nodes: [ENTRY, MSG],
      edges: [{ id: "x1", source: "e0", target: "a1" }, { id: "x2", source: "a1", target: "a1" }],
    });

    const res = await run();

    expect(res.reason).toBe("loop_guard");
    expect(handoffUpdate()?.data).toMatchObject({ status: "WAITING", handledBy: "human" });
    expect(systemDivider()?.metadata.flowEndReason).toBe("loop_guard");
  });
});

describe("what the rescue must NOT touch", () => {
  beforeEach(() => {
    flowCanvas.findUnique.mockResolvedValue({
      tenantId: TENANT,
      nodes: [ENTRY, MSG],
      edges: [{ id: "x1", source: "e0", target: "a1" }],
    });
  });

  it("leaves a closed conversation closed", async () => {
    // A flow that closed the conversation and then ran off its own end must
    // not be re-opened into the queue as if it were unfinished.
    conversation.findUnique.mockResolvedValue({
      status: "CLOSED", handledBy: null, isHandedOver: false, assignedAgentId: null,
    });

    await run();

    expect(handoffUpdate()).toBeUndefined();
    expect(systemDivider()).toBeUndefined();
  });

  it("leaves a conversation a human already took", async () => {
    conversation.findUnique.mockResolvedValue({
      status: "OPEN", handledBy: "human", isHandedOver: true, assignedAgentId: "u1",
    });

    await run();

    expect(handoffUpdate()).toBeUndefined();
  });

  it("leaves a conversation an AI employee owns", async () => {
    // `handledBy: "ai_agent"` means route_target dispatched and the employee is
    // mid-answer. Yanking it to WAITING would interrupt a working handoff.
    conversation.findUnique.mockResolvedValue({
      status: "OPEN", handledBy: "ai_agent", isHandedOver: false, assignedAgentId: null,
    });

    await run();

    expect(handoffUpdate()).toBeUndefined();
  });

  it("never throws the rescue's own failure into the inbound pipeline", async () => {
    // A stranded conversation must not also become a retried job that strands
    // it again on every redelivery.
    conversation.findUnique.mockRejectedValue(new Error("db down"));

    await expect(run()).resolves.toMatchObject({ halted: true });
  });
});
