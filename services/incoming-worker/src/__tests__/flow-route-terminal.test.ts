/**
 * Reachability around `route_target`.
 *
 * `route_target` is a TERMINAL node: flow-executor.service.ts returns from the
 * walk the moment it dispatches, so its outgoing edge is never followed. Any
 * node placed after it is unreachable - not skipped by a bug, unreachable by
 * construction.
 *
 * These tests pin both topologies and print the node-by-node execution path,
 * because "which order was the graph actually in" is the question that decides
 * whether an incident is an executor bug or a graph-shape problem.
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

const AI_NODE = { id: "r1", type: "route_target", data: { routeType: "agent", targetId: "ai-employee-1" } };
const MSG_A = { id: "a1", type: "send_message_text", data: { text: "message A" } };
const INT_B = {
  id: "b1",
  type: "send_message_interactive",
  data: { text: "interactive B", buttonLabel: "Open", buttonUrl: "https://example.com" },
};
const ENTRY = { id: "e0", type: "channel_entry", data: { channel: "whatsapp" } };

function sentBodies() {
  return sendTextMessage.mock.calls.map((c: any[]) => c[3]);
}

/** Renders the executor's own trace as the node-by-node path. */
function renderPath(res: any): string {
  const rows = res.trace.map(
    (t: any) => `  ${t.nodeId.padEnd(4)} ${String(t.type).padEnd(26)} ${t.action}`,
  );
  return [
    ...rows,
    `  -> executed=${res.executed} halted=${res.halted} reason=${res.reason ?? "-"}`,
    `  -> route=${res.route ? `${res.route.routeType}:${res.route.targetId}` : "-"}`,
  ].join("\n");
}

beforeEach(() => {
  vi.clearAllMocks();
  conversation.findFirst.mockResolvedValue({
    id: CONV,
    tenantId: TENANT,
    channel: "WHATSAPP",
    customerExternalId: "972500000000",
    flowVariables: {},
    channelAccount: { externalId: "wa-1", credentials: {} },
    isHandedOver: false,
  });
  conversation.update.mockResolvedValue({});
  message.create.mockResolvedValue({ id: "m1", createdAt: new Date() });
  sendTextMessage.mockResolvedValue("wamid.1");
  processAIBot.mockResolvedValue(true);
});

describe("topology A: deterministic nodes BEFORE the AI node", () => {
  beforeEach(() => {
    flowCanvas.findUnique.mockResolvedValue({
      tenantId: TENANT,
      nodes: [ENTRY, MSG_A, INT_B, AI_NODE],
      edges: [
        { id: "x1", source: "e0", target: "a1" },
        { id: "x2", source: "a1", target: "b1" },
        { id: "x3", source: "b1", target: "r1" },
      ],
    });
  });

  it("sends A and B, and only then crosses the AI billing boundary", async () => {
    const res = await executeMainFlow({
      tenantId: TENANT,
      conversationId: CONV,
      message: "hi",
      channel: "whatsapp",
    });
    console.log("\n[TOPOLOGY A] START -> send_message A -> send_interactive B -> route_target(ai)\n" + renderPath(res));

    // Both deterministic sends happened, with zero AI credits.
    expect(sentBodies()[0]).toBe("message A");
    expect(sentBodies()[1]).toContain("interactive B");
    // The AI boundary is crossed last, exactly once.
    expect(processAIBot).toHaveBeenCalledTimes(1);
    // And the walk stopped AT the route node.
    expect(res.matchedNodeId).toBe("r1");
    expect(res.reason).toBe("route_dispatched");
  });

  it("sends both deterministic messages even when the AI turn is refused", async () => {
    // Zero credits: the AI service answers with a billing escalation and
    // processAIBot hands off to a human. That must not retroactively cancel
    // the two messages the flow already sent.
    processAIBot.mockImplementation(async () => {
      throw new Error("billing_blocked:units_exhausted");
    });

    await executeMainFlow({
      tenantId: TENANT,
      conversationId: CONV,
      message: "hi",
      channel: "whatsapp",
    }).catch(() => {});

    expect(sentBodies()[0]).toBe("message A");
    expect(sentBodies()[1]).toContain("interactive B");
  });
});

describe("topology B: deterministic nodes AFTER the AI node", () => {
  beforeEach(() => {
    flowCanvas.findUnique.mockResolvedValue({
      tenantId: TENANT,
      nodes: [ENTRY, AI_NODE, MSG_A, INT_B],
      edges: [
        { id: "y1", source: "e0", target: "r1" },
        { id: "y2", source: "r1", target: "a1" },
        { id: "y3", source: "a1", target: "b1" },
      ],
    });
  });

  it("stops at the route node: A and B are unreachable by construction", async () => {
    const res = await executeMainFlow({
      tenantId: TENANT,
      conversationId: CONV,
      message: "hi",
      channel: "whatsapp",
    });
    console.log("\n[TOPOLOGY B] START -> route_target(ai) -> send_message A -> send_interactive B\n" + renderPath(res));

    // The AI boundary was crossed...
    expect(processAIBot).toHaveBeenCalledTimes(1);
    // ...and NOTHING downstream ran. Not skipped - never reached.
    expect(sentBodies()).toEqual([]);
    expect(res.matchedNodeId).toBe("r1");
    expect(res.reason).toBe("route_dispatched");
    // The trace is the proof: it ends at the route node.
    expect(res.trace[res.trace.length - 1].nodeId).toBe("r1");
    expect(res.trace.some((t: any) => t.nodeId === "a1")).toBe(false);
    expect(res.trace.some((t: any) => t.nodeId === "b1")).toBe(false);
  });

  it("is terminal for every route type, not just agent", async () => {
    // Same shape with a human route - the outgoing edge is ignored there too,
    // so this is a property of route_target, not of AI or of billing.
    flowCanvas.findUnique.mockResolvedValue({
      tenantId: TENANT,
      nodes: [ENTRY, { id: "r1", type: "route_target", data: { routeType: "human", targetId: null } }, MSG_A],
      edges: [
        { id: "z1", source: "e0", target: "r1" },
        { id: "z2", source: "r1", target: "a1" },
      ],
    });

    const res = await executeMainFlow({
      tenantId: TENANT,
      conversationId: CONV,
      message: "hi",
      channel: "whatsapp",
    });

    expect(sentBodies()).toEqual([]);
    expect(res.reason).toBe("route_dispatched");
  });
});
