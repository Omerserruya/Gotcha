import { describe, it, expect, vi, beforeEach } from "vitest";

// Sibling stubs so importing the executor doesn't drag in the AI stack.
vi.mock("../services/ai-bot.service", () => ({ processAIBot: vi.fn() }));
vi.mock("../services/identity-link.service", () => ({
  tryLinkIdentifierFromInbound: vi.fn(),
}));

// A fake outbound adapter that records every dispatch so tests can assert the
// recipient/credentials/account threaded through unchanged. `getOutboundAdapter`
// returns it for every channel here.
const { chatbotFlow, channelAccount, messageTemplate, conversation, flowCanvas, adapter } =
  vi.hoisted(() => ({
    chatbotFlow: { findFirst: vi.fn(), update: vi.fn() },
    channelAccount: { findFirst: vi.fn() },
    messageTemplate: { findFirst: vi.fn() },
    conversation: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    flowCanvas: { findUnique: vi.fn() },
    adapter: {
      sendTextMessage: vi.fn().mockResolvedValue("wamid.text"),
      sendTemplateMessage: vi.fn().mockResolvedValue("wamid.tmpl"),
    },
  }));

vi.mock("@chatcenter/shared", () => ({
  prisma: {
    chatbotFlow,
    channelAccount,
    messageTemplate,
    conversation,
    contact: { findFirst: vi.fn() },
    message: { create: vi.fn() },
    flowCanvas,
  },
  getOutboundAdapter: vi.fn(() => adapter),
  decryptCredentials: vi.fn(() => ({ accessToken: "decrypted-token" })),
  publishEvent: vi.fn().mockResolvedValue(undefined),
  flowResumeQueue: { add: vi.fn().mockResolvedValue(undefined) },
}));

import { executeWebhookFlow } from "../services/flow-executor.service";

interface TestNode { id: string; type: string; data: Record<string, unknown>; }
interface TestEdge { id: string; source: string; target: string; sourceHandle?: string; }

function flowGraph(nodes: TestNode[], edges: TestEdge[]) {
  return { id: "flow-1", tenantId: "tenant-1", isActive: true, nodes, edges };
}

beforeEach(() => {
  vi.clearAllMocks();
  chatbotFlow.update.mockResolvedValue({});
  channelAccount.findFirst.mockResolvedValue({
    id: "acct-1",
    externalId: "1234567890",
    channel: "WHATSAPP",
    credentials: "encrypted-blob",
    isActive: true,
  });
});

describe("send_message_text — context-free explicit recipient", () => {
  it("dispatches via the existing outbound path when an explicit recipient is set", async () => {
    const nodes: TestNode[] = [
      { id: "n1", type: "start", data: {} },
      {
        id: "n2",
        type: "send_message_text",
        data: { text: "Hi {{body.name}}", recipient: "{{body.phone_number}}" },
      },
    ];
    const edges: TestEdge[] = [{ id: "e1", source: "n1", target: "n2" }];
    chatbotFlow.findFirst.mockResolvedValue(flowGraph(nodes, edges));

    const res = await executeWebhookFlow({
      tenantId: "tenant-1",
      workflowId: "flow-1",
      payload: { name: "Dana", phone_number: "+972501234567" },
    });

    expect(res.executed).toBe(true);
    // Resolved an active WhatsApp account for the tenant (recipient is phone-like).
    expect(channelAccount.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: "tenant-1",
          channel: "WHATSAPP",
          isActive: true,
        }),
      }),
    );
    // Dispatched with the interpolated recipient + decrypted creds + account id.
    expect(adapter.sendTextMessage).toHaveBeenCalledWith(
      { accessToken: "decrypted-token" },
      "1234567890",
      "+972501234567",
      "Hi Dana",
    );
    // Context-free: no conversation row touched.
    expect(conversation.findUnique).not.toHaveBeenCalled();
    expect(conversation.update).not.toHaveBeenCalled();
  });

  it("no-ops (no dispatch) when the send node has no explicit recipient", async () => {
    const nodes: TestNode[] = [
      { id: "n1", type: "start", data: {} },
      { id: "n2", type: "send_message_text", data: { text: "Hi there" } },
    ];
    const edges: TestEdge[] = [{ id: "e1", source: "n1", target: "n2" }];
    chatbotFlow.findFirst.mockResolvedValue(flowGraph(nodes, edges));

    const res = await executeWebhookFlow({
      tenantId: "tenant-1",
      workflowId: "flow-1",
      payload: {},
    });

    expect(res.executed).toBe(true);
    expect(channelAccount.findFirst).not.toHaveBeenCalled();
    expect(adapter.sendTextMessage).not.toHaveBeenCalled();
  });

  it("skips when no active channel account backs the inferred channel", async () => {
    channelAccount.findFirst.mockResolvedValue(null);
    const nodes: TestNode[] = [
      { id: "n1", type: "start", data: {} },
      {
        id: "n2",
        type: "send_message_text",
        data: { text: "Hi", recipient: "+972500000000" },
      },
    ];
    const edges: TestEdge[] = [{ id: "e1", source: "n1", target: "n2" }];
    chatbotFlow.findFirst.mockResolvedValue(flowGraph(nodes, edges));

    const res = await executeWebhookFlow({
      tenantId: "tenant-1",
      workflowId: "flow-1",
      payload: {},
    });

    expect(res.executed).toBe(true);
    expect(adapter.sendTextMessage).not.toHaveBeenCalled();
  });
});

describe("send_message_template — context-free explicit recipient", () => {
  it("dispatches the template to an explicit recipient with no conversation", async () => {
    messageTemplate.findFirst.mockResolvedValue({
      id: "tmpl-1",
      tenantId: "tenant-1",
      name: "order_update",
      language: "en",
      status: "APPROVED",
      body: "Hello {{1}}",
      headerType: null,
      headerContent: null,
      variables: [],
    });
    const nodes: TestNode[] = [
      { id: "n1", type: "start", data: {} },
      {
        id: "n2",
        type: "send_message_template",
        data: {
          templateId: "tmpl-1",
          recipient: "{{body.phone_number}}",
          variables: { "1": "{{body.name}}" },
        },
      },
    ];
    const edges: TestEdge[] = [{ id: "e1", source: "n1", target: "n2" }];
    chatbotFlow.findFirst.mockResolvedValue(flowGraph(nodes, edges));

    const res = await executeWebhookFlow({
      tenantId: "tenant-1",
      workflowId: "flow-1",
      payload: { name: "Dana", phone_number: "+972501234567" },
    });

    expect(res.executed).toBe(true);
    const tmplEntry = res.trace.find((t) => t.type === "send_message_template");
    expect(tmplEntry?.action).toBe("sent");
    expect(adapter.sendTemplateMessage).toHaveBeenCalledWith(
      { accessToken: "decrypted-token" },
      "1234567890",
      "+972501234567",
      "order_update",
      "en",
      expect.any(Array),
    );
    // No Contact/Conversation lookup on the context-free path.
    expect(conversation.findUnique).not.toHaveBeenCalled();
  });

  it("still no-ops when the template node has no explicit recipient", async () => {
    const nodes: TestNode[] = [
      { id: "n1", type: "start", data: {} },
      { id: "n2", type: "send_message_template", data: { templateId: "tmpl-1" } },
    ];
    const edges: TestEdge[] = [{ id: "e1", source: "n1", target: "n2" }];
    chatbotFlow.findFirst.mockResolvedValue(flowGraph(nodes, edges));

    const res = await executeWebhookFlow({
      tenantId: "tenant-1",
      workflowId: "flow-1",
      payload: {},
    });

    const tmplEntry = res.trace.find((t) => t.type === "send_message_template");
    expect(tmplEntry?.action).toBe("skipped_no_send_ctx");
    expect(adapter.sendTemplateMessage).not.toHaveBeenCalled();
  });
});

// ─── Manual field mapper (Card 5) — connected-nodes mode ─────────────
// The webhook trigger node carries `data.fieldMapping` binding declared body
// fields onto the first connected node's inputs. The send node itself has NO
// recipient/text — the mapping is what makes it dispatch.
describe("webhook field mapper — connected mode", () => {
  function canvas(nodes: TestNode[], edges: TestEdge[]) {
    return { tenantId: "tenant-1", nodes, edges };
  }

  it("injects mapped body fields into the first connected text node", async () => {
    const nodes: TestNode[] = [
      {
        id: "w1",
        type: "webhook_trigger",
        data: {
          workflowId: "flow-1",
          targetMode: "connected",
          fieldMapping: [
            { source: "phone_number", target: "recipient" },
            { source: "greeting", target: "text" },
          ],
        },
      },
      // Authored with neither recipient nor text — both come from the mapping.
      { id: "n2", type: "send_message_text", data: {} },
    ];
    const edges: TestEdge[] = [{ id: "e1", source: "w1", target: "n2" }];
    flowCanvas.findUnique.mockResolvedValue(canvas(nodes, edges));

    const res = await executeWebhookFlow({
      tenantId: "tenant-1",
      workflowId: "flow-1",
      payload: { phone_number: "+972501234567", greeting: "Hello Dana" },
      targetMode: "connected",
    });

    expect(res.executed).toBe(true);
    expect(adapter.sendTextMessage).toHaveBeenCalledWith(
      { accessToken: "decrypted-token" },
      "1234567890",
      "+972501234567",
      "Hello Dana",
    );
  });

  it("maps recipient + a template variable (var:<key>) onto a template node", async () => {
    messageTemplate.findFirst.mockResolvedValue({
      id: "tmpl-1",
      tenantId: "tenant-1",
      name: "order_update",
      language: "en",
      status: "APPROVED",
      body: "Hello {{name}}",
      headerType: null,
      headerContent: null,
      variables: [],
    });
    const nodes: TestNode[] = [
      {
        id: "w1",
        type: "webhook_trigger",
        data: {
          workflowId: "flow-1",
          targetMode: "connected",
          fieldMapping: [
            { source: "phone_number", target: "recipient" },
            { source: "customer_name", target: "var:name" },
          ],
        },
      },
      { id: "n2", type: "send_message_template", data: { templateId: "tmpl-1" } },
    ];
    const edges: TestEdge[] = [{ id: "e1", source: "w1", target: "n2" }];
    flowCanvas.findUnique.mockResolvedValue(canvas(nodes, edges));

    const res = await executeWebhookFlow({
      tenantId: "tenant-1",
      workflowId: "flow-1",
      payload: { phone_number: "+972501234567", customer_name: "Dana" },
      targetMode: "connected",
    });

    expect(res.executed).toBe(true);
    const tmplEntry = res.trace.find((t) => t.type === "send_message_template");
    expect(tmplEntry?.action).toBe("sent");
    expect(adapter.sendTemplateMessage).toHaveBeenCalledWith(
      { accessToken: "decrypted-token" },
      "1234567890",
      "+972501234567",
      "order_update",
      "en",
      expect.any(Array),
    );
  });

  it("no-ops when the trigger has no mapping and the node has no recipient", async () => {
    const nodes: TestNode[] = [
      { id: "w1", type: "webhook_trigger", data: { workflowId: "flow-1", targetMode: "connected" } },
      { id: "n2", type: "send_message_text", data: { text: "Hi" } },
    ];
    const edges: TestEdge[] = [{ id: "e1", source: "w1", target: "n2" }];
    flowCanvas.findUnique.mockResolvedValue(canvas(nodes, edges));

    const res = await executeWebhookFlow({
      tenantId: "tenant-1",
      workflowId: "flow-1",
      payload: { phone_number: "+972501234567" },
      targetMode: "connected",
    });

    expect(res.executed).toBe(true);
    expect(adapter.sendTextMessage).not.toHaveBeenCalled();
  });
});
