import { describe, it, expect, vi, beforeEach } from "vitest";

// The flow executor imports two sibling services at module load. Stub them so
// importing the executor under test doesn't drag in the OpenAI / AI stack.
vi.mock("../services/ai-bot.service", () => ({ processAIBot: vi.fn() }));
vi.mock("../services/identity-link.service", () => ({
  tryLinkIdentifierFromInbound: vi.fn(),
}));

// Mock @chatcenter/shared down to just what a context-free run touches. The
// `conversation` mock is deliberately included so the tests can assert it is
// NEVER called on a context-free webhook run. `vi.hoisted` makes these mock
// objects available inside the (hoisted) vi.mock factory below.
const { chatbotFlow, conversation, flowCanvas } = vi.hoisted(() => ({
  chatbotFlow: { findFirst: vi.fn(), update: vi.fn() },
  conversation: { update: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn() },
  flowCanvas: { findUnique: vi.fn() },
}));

vi.mock("@chatcenter/shared", () => ({
  // Durable tenant settings (business hours, auto-greeting, SLA). Exhaustive
  // mocks of this barrel must supply them or the read path throws instead of
  // returning "not configured". Default: nothing configured.
  readDurableSetting: async () => null,
  writeDurableSetting: async () => undefined,
  settingCacheKey: (t: string, k: string) => `tenant:${t}:${k}`,
  // Version pins now live in shared modules, so exhaustive mocks of this
  // barrel must supply them. Returning the real defaults keeps any URL the
  // code builds meaningful instead of "undefined/...".
  shopifyApiVersion: () => "2026-07",
  checkShopifyResponseVersion: () => ({ ok: true, served: "2026-07" }),
  metaGraphBaseUrl: (legacy?: string) => legacy || "https://graph.facebook.com/v24.0",
  stripeVersionHeader: () => ({ "Stripe-Version": "2026-02-25.clover" }),
  prisma: {
    chatbotFlow,
    conversation,
    flowCanvas,
    contact: { findFirst: vi.fn(), update: vi.fn() },
    message: { create: vi.fn() },
    messageTemplate: { findFirst: vi.fn() },
  },
  getOutboundAdapter: vi.fn(() => null),
  decryptCredentials: vi.fn(() => ({})),
  publishEvent: vi.fn().mockResolvedValue(undefined),
  flowResumeQueue: { add: vi.fn().mockResolvedValue(undefined) },
}));

import { executeWebhookFlow } from "../services/flow-executor.service";

interface TestNode {
  id: string;
  type: string;
  data: Record<string, unknown>;
}
interface TestEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
}

function flowGraph(nodes: TestNode[], edges: TestEdge[]) {
  return { id: "flow-1", tenantId: "tenant-1", isActive: true, nodes, edges };
}

beforeEach(() => {
  vi.clearAllMocks();
  chatbotFlow.update.mockResolvedValue({});
});

describe("executeWebhookFlow (context-free)", () => {
  it("returns not-executed when the workflow can't be resolved", async () => {
    chatbotFlow.findFirst.mockResolvedValue(null);

    const res = await executeWebhookFlow({
      tenantId: "tenant-1",
      workflowId: "missing",
      payload: { any: "thing" },
    });

    expect(res.executed).toBe(false);
    expect(res.halted).toBe(false);
  });

  it("exposes the payload as `body.<field>` to downstream nodes", async () => {
    const nodes: TestNode[] = [
      { id: "n1", type: "start", data: {} },
      { id: "n2", type: "set_variable", data: { variable: "captured", value: "{{body.order_id}}" } },
      { id: "n3", type: "end", data: { kind: "close" } },
    ];
    const edges: TestEdge[] = [
      { id: "e1", source: "n1", target: "n2" },
      { id: "e2", source: "n2", target: "n3" },
    ];
    chatbotFlow.findFirst.mockResolvedValue(flowGraph(nodes, edges));

    const res = await executeWebhookFlow({
      tenantId: "tenant-1",
      workflowId: "flow-1",
      payload: { order_id: 42, customer: { email: "a@b.com" } },
    });

    expect(res.executed).toBe(true);
    const setEntry = res.trace.find(
      (t) => t.type === "set_variable" && t.action === "set",
    );
    // n8n-style: the node read `{{body.order_id}}` from the injected payload.
    expect(setEntry?.detail?.value).toBe("42");
  });

  it("resolves nested dotted payload paths and honors a webhook_trigger entry", async () => {
    const nodes: TestNode[] = [
      { id: "n1", type: "webhook_trigger", data: {} },
      { id: "n2", type: "set_variable", data: { variable: "email", value: "{{body.customer.email}}" } },
    ];
    const edges: TestEdge[] = [{ id: "e1", source: "n1", target: "n2" }];
    chatbotFlow.findFirst.mockResolvedValue(flowGraph(nodes, edges));

    const res = await executeWebhookFlow({
      tenantId: "tenant-1",
      workflowId: "flow-1",
      payload: { customer: { email: "x@y.z" } },
    });

    const setEntry = res.trace.find((t) => t.type === "set_variable");
    expect(setEntry?.detail?.value).toBe("x@y.z");
    // Bookkeeping parity with sub-flow dispatch.
    expect(chatbotFlow.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { runCount: { increment: 1 } } }),
    );
  });

  it("never reads or writes a Conversation row on a context-free run", async () => {
    const nodes: TestNode[] = [
      { id: "n1", type: "start", data: {} },
      { id: "n2", type: "set_variable", data: { variable: "x", value: "{{body.k}}" } },
      { id: "n3", type: "end", data: { kind: "close" } },
    ];
    const edges: TestEdge[] = [
      { id: "e1", source: "n1", target: "n2" },
      { id: "e2", source: "n2", target: "n3" },
    ];
    chatbotFlow.findFirst.mockResolvedValue(flowGraph(nodes, edges));

    await executeWebhookFlow({
      tenantId: "tenant-1",
      workflowId: "flow-1",
      payload: { k: "v" },
    });

    expect(conversation.update).not.toHaveBeenCalled();
    expect(conversation.findFirst).not.toHaveBeenCalled();
    expect(conversation.findUnique).not.toHaveBeenCalled();
  });

  it("falls back to the first node when there is no start/trigger node", async () => {
    // A single isolated node with no edges: entry is the node itself, walk
    // visits it then stops. Still a clean, conversation-free execution.
    const nodes: TestNode[] = [{ id: "only", type: "set_variable", data: { variable: "a", value: "{{body.v}}" } }];
    chatbotFlow.findFirst.mockResolvedValue(flowGraph(nodes, []));

    const res = await executeWebhookFlow({
      tenantId: "tenant-1",
      workflowId: "flow-1",
      payload: { v: "hello" },
    });

    expect(res.executed).toBe(true);
    const setEntry = res.trace.find((t) => t.type === "set_variable");
    expect(setEntry?.detail?.value).toBe("hello");
  });
});

describe("executeWebhookFlow - connected-nodes mode", () => {
  function canvas(nodes: TestNode[], edges: TestEdge[]) {
    return { id: "canvas-1", tenantId: "tenant-1", nodes, edges };
  }

  it("walks the canvas from the matching webhook trigger node, never running the flow", async () => {
    const nodes: TestNode[] = [
      // Two webhook triggers on the canvas; only the one bound to this workflow runs.
      { id: "wt-other", type: "webhook_trigger", data: { workflowId: "other" } },
      { id: "wt-1", type: "webhook_trigger", data: { workflowId: "flow-1" } },
      { id: "n2", type: "set_variable", data: { variable: "captured", value: "{{body.order_id}}" } },
      { id: "n3", type: "end", data: { kind: "close" } },
    ];
    const edges: TestEdge[] = [
      { id: "e1", source: "wt-1", target: "n2" },
      { id: "e2", source: "n2", target: "n3" },
    ];
    flowCanvas.findUnique.mockResolvedValue(canvas(nodes, edges));

    const res = await executeWebhookFlow({
      tenantId: "tenant-1",
      workflowId: "flow-1",
      payload: { order_id: 99 },
      targetMode: "connected",
    });

    expect(res.executed).toBe(true);
    const setEntry = res.trace.find((t) => t.type === "set_variable" && t.action === "set");
    expect(setEntry?.detail?.value).toBe("99");
    // Connected mode reads the canvas, never the ChatbotFlow.
    expect(chatbotFlow.findFirst).not.toHaveBeenCalled();
    // Context-free: no Conversation touched.
    expect(conversation.update).not.toHaveBeenCalled();
  });

  it("returns not-executed when the tenant has no canvas", async () => {
    flowCanvas.findUnique.mockResolvedValue(null);

    const res = await executeWebhookFlow({
      tenantId: "tenant-1",
      workflowId: "flow-1",
      payload: {},
      targetMode: "connected",
    });

    expect(res.executed).toBe(false);
    expect(res.halted).toBe(false);
  });

  it("halts cleanly when the trigger node has no outgoing edge", async () => {
    const nodes: TestNode[] = [{ id: "wt-1", type: "webhook_trigger", data: { workflowId: "flow-1" } }];
    flowCanvas.findUnique.mockResolvedValue(canvas(nodes, []));

    const res = await executeWebhookFlow({
      tenantId: "tenant-1",
      workflowId: "flow-1",
      payload: {},
      targetMode: "connected",
    });

    expect(res.executed).toBe(true);
    expect(res.halted).toBe(true);
    expect(res.reason).toBe("no_outgoing_edge");
  });
});
