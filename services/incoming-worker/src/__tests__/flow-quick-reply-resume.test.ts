/**
 * Quick-reply resume: which edge does the flow actually take?
 *
 * The contract, stated in the editor registry
 * (frontend/.../node-registry.tsx, `send_message_quick_reply.getSources`):
 *
 *   "One exit per reply - handle id matches the lowercased PAYLOAD so the
 *    runtime (flow-executor) can route by `sourceHandle === payload`."
 *
 * What actually reaches the runtime is the button TITLE, not the payload:
 *
 *   services/webhook/.../webhook.ts:326
 *     body = content.interactiveReply.title || content.text || ""
 *   services/incoming-worker/.../incoming.worker.ts
 *     executeMainFlow({ message: body, resumeNodeId: conversation.chatbotNodeId })
 *   services/incoming-worker/.../flow-executor.service.ts (resume branch)
 *     payload  = opts.message.toLowerCase().trim()        <- the TITLE
 *     selected = out.find(e => e.sourceHandle === payload) || out[0]
 *
 * So the match only succeeds when label and payload happen to be the same
 * string - which is exactly what the default reply (`label: "Yes", payload:
 * "yes"`) looks like, and is why this never showed up in a smoke test. Give a
 * button a real payload key and the match fails silently, falling through to
 * `out[0]`: the first outgoing edge in persisted array order.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { processAIBot } = vi.hoisted(() => ({ processAIBot: vi.fn() }));
vi.mock("../services/ai-bot.service", () => ({ processAIBot }));
vi.mock("../services/identity-link.service", () => ({
  tryLinkIdentifierFromInbound: vi.fn(),
}));

const { conversation, flowCanvas, chatbotFlow, message, sendTextMessage, sendInteractiveMessage } =
  vi.hoisted(() => ({
    conversation: { update: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn() },
    flowCanvas: { findUnique: vi.fn() },
    chatbotFlow: { findFirst: vi.fn(), update: vi.fn() },
    message: { create: vi.fn() },
    sendTextMessage: vi.fn(),
    sendInteractiveMessage: vi.fn(),
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
  getOutboundAdapter: vi.fn(() => ({ sendTextMessage, sendInteractiveMessage })),
  decryptCredentials: vi.fn(() => ({})),
  publishEvent: vi.fn().mockResolvedValue(undefined),
  flowResumeQueue: { add: vi.fn().mockResolvedValue(undefined) },
  describeSendError: () => ({ sendError: null, errorMessage: null }),
  safeFetch: vi.fn(),
}));

import { executeMainFlow } from "../services/flow-executor.service";

const TENANT = "tenant-1";
const CONV = "conv-1";

// The customer taps "Continue"; its machine key is "continue_shopping".
// label !== payload, which is the normal case for an author-written flow.
const REPLIES = [
  { id: "r1", label: "Continue", payload: "continue_shopping" },
  { id: "r2", label: "Talk to sales", payload: "sales" },
];

const NODES = [
  { id: "e0", type: "channel_entry", data: { channel: "whatsapp" } },
  { id: "A", type: "send_message_text", data: { text: "message A" } },
  { id: "B", type: "send_message_quick_reply", data: { text: "pick one", replies: REPLIES } },
  { id: "C", type: "send_message_text", data: { text: "message C" } },
  { id: "R", type: "route_target", data: { routeType: "agent", targetId: "ai-employee-1" } },
];

// Edge order is the persisted array order. The "sales" branch happens to be
// stored first - authors have no control over and no visibility into this.
const EDGES_SALES_FIRST = [
  { id: "x0", source: "e0", target: "A" },
  { id: "x1", source: "A", target: "B" },
  { id: "x2", source: "B", target: "R", sourceHandle: "sales" },
  { id: "x3", source: "B", target: "C", sourceHandle: "continue_shopping" },
  { id: "x4", source: "C", target: "R" },
];

function sentBodies() {
  return sendTextMessage.mock.calls.map((c: any[]) => c[3]);
}

function renderPath(label: string, res: any): string {
  const rows = res.trace.map(
    (t: any) => `  ${String(t.nodeId).padEnd(3)} ${String(t.type).padEnd(26)} ${t.action}`,
  );
  return [
    `\n[${label}]`,
    ...rows,
    `  -> halted=${res.halted} reason=${res.reason ?? "-"} matched=${res.matchedNodeId ?? "-"}`,
    `  -> route=${res.route ? `${res.route.routeType}:${res.route.targetId}` : "-"}`,
  ].join("\n");
}

beforeEach(() => {
  vi.clearAllMocks();
  flowCanvas.findUnique.mockResolvedValue({ tenantId: TENANT, nodes: NODES, edges: EDGES_SALES_FIRST });
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
  sendInteractiveMessage.mockResolvedValue("wamid.2");
  processAIBot.mockResolvedValue(true);
});

describe("initial execution", () => {
  it("sends A, sends the quick reply, and parks the cursor on B", async () => {
    const res = await executeMainFlow({
      tenantId: TENANT,
      conversationId: CONV,
      message: "hi",
      channel: "whatsapp",
    });
    console.log(renderPath("INITIAL  entry -> A -> B(quick reply)", res));

    expect(sentBodies()).toEqual(["message A"]);
    expect(sendInteractiveMessage).toHaveBeenCalledTimes(1);
    expect(res.reason).toBe("wait_for_reply");
    expect(res.matchedNodeId).toBe("B");
    // Cursor persisted correctly - cause 2 and 4 are eliminated here.
    const cursorWrite = conversation.update.mock.calls
      .map((c: any[]) => c[0]?.data)
      .find((d: any) => d?.chatbotNodeId !== undefined);
    expect(cursorWrite).toEqual({ chatbotNodeId: "B", handledBy: "flow" });
  });
});

describe("resumed execution: what the customer's tap resolves to", () => {
  it("routes by the tapped PAYLOAD and sends C before the AI node", async () => {
    // What incoming.worker now passes: message = the button TITLE (that is
    // what the webhook puts in the body), replyPayload = the button id.
    const res = await executeMainFlow({
      tenantId: TENANT,
      conversationId: CONV,
      message: "Continue",
      channel: "whatsapp",
      resumeNodeId: "B",
      replyPayload: "continue_shopping",
    });
    console.log(renderPath('RESUME title="Continue" payload="continue_shopping"', res));

    expect(sentBodies()).toEqual(["message C"]);
    // C ran BEFORE the AI node, which is the whole point.
    const order = res.trace.map((t: any) => t.nodeId);
    expect(order.indexOf("C")).toBeLessThan(order.indexOf("R"));
    expect(processAIBot).toHaveBeenCalledTimes(1);
  });

  it("resolves a title-only reply through the node's replies, not through edge order", async () => {
    // The exact regression: title "Continue" matches no EXIT ("sales",
    // "continue_shopping"). It must not silently take out[0] - the sales
    // branch, ending at the AI node with C skipped. Instead the title is
    // resolved against the node's own replies to its payload.
    const res = await executeMainFlow({
      tenantId: TENANT,
      conversationId: CONV,
      message: "Continue",
      channel: "whatsapp",
      resumeNodeId: "B",
    });
    console.log(renderPath('RESUME title-only "Continue"', res));

    expect(sentBodies()).toEqual(["message C"]);
    const order = res.trace.map((t: any) => t.nodeId);
    expect(order.indexOf("C")).toBeLessThan(order.indexOf("R"));
  });

  it("stays unresolved when the text matches no label and no payload", async () => {
    const res = await executeMainFlow({
      tenantId: TENANT,
      conversationId: CONV,
      message: "who is this",
      channel: "whatsapp",
      resumeNodeId: "B",
    });
    console.log(renderPath('RESUME unknown text "who is this"', res));

    expect(res.reason).toBe("quick_reply_unresolved");
    expect(res.matchedNodeId).toBe("B");
    expect(processAIBot).not.toHaveBeenCalled();
    expect(sentBodies()).toEqual([]);
  });

  it("does not restart the flow when a tap cannot be resolved", async () => {
    // Returning "no start node" used to fall through to the entry picker,
    // which would re-send A and the quick reply the customer already has.
    await executeMainFlow({
      tenantId: TENANT,
      conversationId: CONV,
      message: "who is this",
      channel: "whatsapp",
      resumeNodeId: "B",
    });

    expect(sentBodies()).not.toContain("message A");
    expect(sendInteractiveMessage).not.toHaveBeenCalled();
  });

  it("still resolves a typed reply that matches a branch by text", async () => {
    const res = await executeMainFlow({
      tenantId: TENANT,
      conversationId: CONV,
      message: "continue_shopping",
      channel: "whatsapp",
      resumeNodeId: "B",
    });

    expect(sentBodies()).toEqual(["message C"]);
    expect(res.reason).toBe("route_dispatched");
  });

  it("takes an unlabelled exit as the explicit anything-else branch", async () => {
    flowCanvas.findUnique.mockResolvedValue({
      tenantId: TENANT,
      nodes: NODES,
      edges: [
        { id: "x0", source: "e0", target: "A" },
        { id: "x1", source: "A", target: "B" },
        { id: "x2", source: "B", target: "R", sourceHandle: "sales" },
        { id: "x3", source: "B", target: "C" }, // no handle = catch-all
        { id: "x4", source: "C", target: "R" },
      ],
    });

    await executeMainFlow({
      tenantId: TENANT,
      conversationId: CONV,
      message: "something the author never anticipated",
      channel: "whatsapp",
      resumeNodeId: "B",
    });

    expect(sentBodies()).toEqual(["message C"]);
  });

  it("takes the only exit when the node has just one", async () => {
    flowCanvas.findUnique.mockResolvedValue({
      tenantId: TENANT,
      nodes: NODES,
      edges: [
        { id: "x0", source: "e0", target: "A" },
        { id: "x1", source: "A", target: "B" },
        { id: "x2", source: "B", target: "C", sourceHandle: "continue_shopping" },
        { id: "x3", source: "C", target: "R" },
      ],
    });

    await executeMainFlow({
      tenantId: TENANT,
      conversationId: CONV,
      message: "anything at all",
      channel: "whatsapp",
      resumeNodeId: "B",
    });

    expect(sentBodies()).toEqual(["message C"]);
  });

  it("hides itself when label and payload happen to match (the default reply)", async () => {
    // defaultData() ships `{ label: "Yes", payload: "yes" }`. Lowercasing the
    // title yields the payload, so the match succeeds by coincidence and the
    // defect is invisible in any flow built from defaults.
    flowCanvas.findUnique.mockResolvedValue({
      tenantId: TENANT,
      nodes: [
        ...NODES.slice(0, 2),
        { id: "B", type: "send_message_quick_reply", data: { text: "pick", replies: [{ id: "r1", label: "Yes", payload: "yes" }] } },
        ...NODES.slice(3),
      ],
      edges: [
        { id: "x0", source: "e0", target: "A" },
        { id: "x1", source: "A", target: "B" },
        { id: "x2", source: "B", target: "C", sourceHandle: "yes" },
        { id: "x3", source: "C", target: "R" },
      ],
    });

    await executeMainFlow({
      tenantId: TENANT,
      conversationId: CONV,
      message: "Yes",
      channel: "whatsapp",
      resumeNodeId: "B",
    });

    expect(sentBodies()).toEqual(["message C"]);
  });
});

// ─── Edge order must not influence routing ──────────────────────

describe("persisted edge order is irrelevant", () => {
  const REVERSED = [
    { id: "x4", source: "C", target: "R" },
    { id: "x3", source: "B", target: "C", sourceHandle: "continue_shopping" },
    { id: "x2", source: "B", target: "R", sourceHandle: "sales" },
    { id: "x1", source: "A", target: "B" },
    { id: "x0", source: "e0", target: "A" },
  ];

  it("routes to C with the sales branch stored FIRST", async () => {
    flowCanvas.findUnique.mockResolvedValue({ tenantId: TENANT, nodes: NODES, edges: EDGES_SALES_FIRST });
    await executeMainFlow({
      tenantId: TENANT, conversationId: CONV, message: "Continue",
      channel: "whatsapp", resumeNodeId: "B", replyPayload: "continue_shopping",
    });
    expect(sentBodies()).toEqual(["message C"]);
  });

  it("routes to C with the edge array fully REVERSED", async () => {
    flowCanvas.findUnique.mockResolvedValue({ tenantId: TENANT, nodes: NODES, edges: REVERSED });
    await executeMainFlow({
      tenantId: TENANT, conversationId: CONV, message: "Continue",
      channel: "whatsapp", resumeNodeId: "B", replyPayload: "continue_shopping",
    });
    expect(sentBodies()).toEqual(["message C"]);
  });

  it("routes to the sales branch when THAT is the payload, either order", async () => {
    for (const edges of [EDGES_SALES_FIRST, REVERSED]) {
      vi.clearAllMocks();
      sendTextMessage.mockResolvedValue("wamid.1");
      processAIBot.mockResolvedValue(true);
      flowCanvas.findUnique.mockResolvedValue({ tenantId: TENANT, nodes: NODES, edges });
      await executeMainFlow({
        tenantId: TENANT, conversationId: CONV, message: "Talk to sales",
        channel: "whatsapp", resumeNodeId: "B", replyPayload: "sales",
      });
      expect(sentBodies()).toEqual([]);
      expect(processAIBot).toHaveBeenCalledTimes(1);
    }
  });
});

// ─── Hebrew label over an ASCII payload ─────────────────────────

describe("non-ASCII labels", () => {
  const HE_NODES = [
    NODES[0], NODES[1],
    {
      id: "B", type: "send_message_quick_reply",
      data: {
        text: "מה תרצו לעשות?",
        replies: [
          { id: "r1", label: "המשך", payload: "continue_shopping" },
          { id: "r2", label: "לדבר עם נציג", payload: "talk_to_agent" },
        ],
      },
    },
    NODES[3], NODES[4],
  ];

  beforeEach(() => {
    flowCanvas.findUnique.mockResolvedValue({ tenantId: TENANT, nodes: HE_NODES, edges: EDGES_SALES_FIRST });
  });

  it("routes by payload when the label is Hebrew", async () => {
    await executeMainFlow({
      tenantId: TENANT, conversationId: CONV, message: "המשך",
      channel: "whatsapp", resumeNodeId: "B", replyPayload: "continue_shopping",
    });
    expect(sentBodies()).toEqual(["message C"]);
  });

  it("resolves a TYPED Hebrew label through the node's replies to its payload", async () => {
    await executeMainFlow({
      tenantId: TENANT, conversationId: CONV, message: "המשך",
      channel: "whatsapp", resumeNodeId: "B",
    });
    expect(sentBodies()).toEqual(["message C"]);
  });

  it("tolerates surrounding whitespace on a typed label", async () => {
    await executeMainFlow({
      tenantId: TENANT, conversationId: CONV, message: "  המשך  ",
      channel: "whatsapp", resumeNodeId: "B",
    });
    expect(sentBodies()).toEqual(["message C"]);
  });
});

// ─── Duplicate / retried inbound ────────────────────────────────

describe("retry and duplicate inbound", () => {
  it("resolves the same branch every time - never drifts to another", async () => {
    for (let i = 0; i < 3; i++) {
      vi.clearAllMocks();
      sendTextMessage.mockResolvedValue("wamid.1");
      processAIBot.mockResolvedValue(true);
      flowCanvas.findUnique.mockResolvedValue({ tenantId: TENANT, nodes: NODES, edges: EDGES_SALES_FIRST });
      const res = await executeMainFlow({
        tenantId: TENANT, conversationId: CONV, message: "Continue",
        channel: "whatsapp", resumeNodeId: "B", replyPayload: "continue_shopping",
      });
      expect(sentBodies()).toEqual(["message C"]);
      expect(res.reason).toBe("route_dispatched");
    }
  });

  it("an unresolved tap stays unresolved on retry, never escalating to a guess", async () => {
    for (let i = 0; i < 3; i++) {
      vi.clearAllMocks();
      flowCanvas.findUnique.mockResolvedValue({ tenantId: TENANT, nodes: NODES, edges: EDGES_SALES_FIRST });
      const res = await executeMainFlow({
        tenantId: TENANT, conversationId: CONV, message: "???",
        channel: "whatsapp", resumeNodeId: "B",
      });
      expect(res.reason).toBe("quick_reply_unresolved");
      expect(processAIBot).not.toHaveBeenCalled();
      expect(sentBodies()).toEqual([]);
    }
  });
});
