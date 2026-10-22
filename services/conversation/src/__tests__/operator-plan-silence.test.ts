/**
 * ★ A plan the team proposed in GOTCHA (Home or the command bar) never talks
 * to the customer, and never changes who handles their conversation.
 * On 2026-10-08 each rejected Home plan sent the customer "הבקשה לא אושרה
 * ולכן הפעולה לא בוצע" (nine times, undelivered only because Meta's 24h window
 * had closed). Reject, approve, and the WhatsApp-decision routes
 * (dispatch-rejected / dispatch-approved): zero outbound, zero customer-facing
 * message rows, no claim of a customer notification, no conversation write.
 * The customer's own requests keep their message, now with Hebrew that agrees.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    rejectRequest: vi.fn(),
    approveRequest: vi.fn(),
    claimForExecution: vi.fn(),
    claimCustomerNotification: vi.fn(),
    linkCustomerMessage: vi.fn(),
    outgoingAdd: vi.fn(),
    prisma: {
      approvalRequest: { findFirst: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      conversation: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
      message: { create: vi.fn(), findMany: vi.fn() },
      tenantTool: { findFirst: vi.fn() },
      user: { findMany: vi.fn().mockResolvedValue([]) },
    } as any,
  },
}));

vi.mock("@chatcenter/shared", () => ({
  readDurableSetting: async () => null,
  writeDurableSetting: async () => undefined,
  settingCacheKey: (t: string, k: string) => `tenant:${t}:${k}`,
  shopifyApiVersion: () => "2026-07",
  checkShopifyResponseVersion: () => ({ ok: true, served: "2026-07" }),
  metaGraphBaseUrl: (l?: string) => l || "https://graph.facebook.com/v24.0",
  stripeVersionHeader: () => ({ "Stripe-Version": "2026-02-25.clover" }),
  prisma: mocks.prisma,
  // Auth is not what this file is about: stand it down so the handler runs.
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: "mgr_1" };
    next();
  },
  resolveTenant: (req: any, _res: any, next: any) => {
    req.tenantId = "tenant_1";
    next();
  },
  requireActiveTenant: () => (_req: any, _res: any, next: any) => next(),
  requireInternalKey: (_req: any, _res: any, next: any) => next(),
  revalidateBeforeExecution: vi.fn(async () => ({ ok: true, decision: "ALLOWED" })),
  approveRequest: (...a: any[]) => mocks.approveRequest(...a),
  rejectRequest: (...a: any[]) => mocks.rejectRequest(...a),
  claimForExecution: (...a: any[]) => mocks.claimForExecution(...a),
  recordExecutionOutcome: vi.fn(),
  claimCustomerNotification: (...a: any[]) => mocks.claimCustomerNotification(...a),
  linkCustomerMessage: (...a: any[]) => mocks.linkCustomerMessage(...a),
  findPendingByConversation: vi.fn(),
  publishEvent: vi.fn().mockResolvedValue(undefined),
  outgoingMessageQueue: { add: (...a: any[]) => mocks.outgoingAdd(...a) },
  getInternalServiceKey: () => "test-key",
}));

import express from "express";
import request from "supertest";
import approvalsRouter from "../routes/approvals";

const app = express();
app.use(express.json());
app.use("/api/approvals", approvalsRouter);


const PLAN = {
  id: "ap_plan",
  tenantId: "tenant_1",
  conversationId: "conv_1",
  tool: "propose_plan",
  params: { summary: "לשייך ל-Noa את השיחה של Omer Serruya (וואטסאפ)", steps: [{ tool: "assign_conversation", params: { conversationId: "conv_1", agentId: "noa" } }], requester: { userId: "matan", name: "Matan" }, source: "home_assistant" },
  status: "PENDING",
  requestedBy: "user:matan",
  expiresAt: new Date(Date.now() + 3600_000),
  riskLevel: "low",
};
const CUSTOMER_ROW = { ...PLAN, id: "ap_c1", tool: "shopify.cancel_order", params: { order_name: "#1009" }, requestedBy: "ai-agent:agent_1" };

function rowIs(row: any) {
  mocks.prisma.approvalRequest.findFirst.mockResolvedValue(row);
  mocks.rejectRequest.mockResolvedValue({ ...row, status: "REJECTED" });
  mocks.approveRequest.mockResolvedValue({ ...row, status: "APPROVED" });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.claimCustomerNotification.mockResolvedValue(true);
  mocks.claimForExecution.mockResolvedValue(true);
  mocks.prisma.conversation.findFirst.mockResolvedValue({
    id: "conv_1", channel: "WHATSAPP", channelAccountId: "acct_1", customerExternalId: "972525401686",
    customerName: "Omer Serruya", assignedAiAgentId: "agent_1", isHandedOver: false, assignedAgentId: null,
  });
  mocks.prisma.conversation.update.mockResolvedValue({});
  mocks.prisma.conversation.updateMany.mockResolvedValue({ count: 1 });
  mocks.prisma.message.create.mockResolvedValue({ id: "msg_1" });
  // The customer writes Hebrew, so a message owed to them is in Hebrew.
  mocks.prisma.message.findMany.mockResolvedValue([{ body: "אני רוצה לבטל את ההזמנה" }]);
  // The ai service: the executor answers ok; the message generator is down, so
  // a customer message (when one is due) is the local fallback.
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (String(url).includes("/grounded") || String(url).includes("/continuation")) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ data: { ok: true } }) };
  }));
});

const silent = () => {
  expect(mocks.outgoingAdd).not.toHaveBeenCalled();
  expect(mocks.prisma.message.create).not.toHaveBeenCalled();
  expect(mocks.claimCustomerNotification).not.toHaveBeenCalled();
  expect(mocks.prisma.conversation.update).not.toHaveBeenCalled();
  expect(mocks.prisma.conversation.updateMany).not.toHaveBeenCalled();
};

describe("★ deciding the team's own plan never reaches the customer", () => {
  it("reject (web): nothing sent, nothing written to the conversation", async () => {
    rowIs(PLAN);
    const r = await request(app).post("/api/approvals/ap_plan/reject").send({ decisionReason: "not now" });
    expect(r.status).toBe(200);
    silent();
  });

  it("approve (web): the action is dispatched, nothing is sent, the conversation is not touched by the approval", async () => {
    rowIs(PLAN);
    const r = await request(app).post("/api/approvals/ap_plan/approve").send({});
    expect(r.status).toBe(200);
    expect(mocks.claimForExecution).toHaveBeenCalled();
    silent();
  });

  it("the WhatsApp-decision routes too: dispatch-rejected and dispatch-approved", async () => {
    rowIs({ ...PLAN, status: "REJECTED" });
    expect((await request(app).post("/api/approvals/ap_plan/dispatch-rejected").set("x-tenant-id", "tenant_1").send({})).status).toBe(200);
    silent();
    rowIs({ ...PLAN, status: "APPROVED" });
    await request(app).post("/api/approvals/ap_plan/dispatch-approved").set("x-tenant-id", "tenant_1").send({});
    silent();
  });

  it("a plan from the command bar, and any propose_plan, is the team's", async () => {
    rowIs({ ...PLAN, params: { ...PLAN.params, source: "command_bar" } });
    await request(app).post("/api/approvals/ap_plan/reject").send({ decisionReason: "x" });
    silent();
    rowIs({ ...PLAN, params: { steps: [] } });
    await request(app).post("/api/approvals/ap_plan/reject").send({ decisionReason: "x" });
    silent();
  });

  it("any action raised from Home or the command bar is the team's, whatever the tool", async () => {
    rowIs({ ...PLAN, tool: "assign_conversation", params: { conversationId: "conv_1", agentId: "noa", source: "home_assistant" } });
    await request(app).post("/api/approvals/ap_plan/reject").send({ decisionReason: "x" });
    silent();
    rowIs({ ...PLAN, tool: "assign_conversation", params: { conversationId: "conv_1", agentId: "noa", source: "command_bar" }, status: "REJECTED" });
    await request(app).post("/api/approvals/ap_plan/dispatch-rejected").set("x-tenant-id", "tenant_1").send({});
    silent();
  });
});

describe("★ the customer's own request keeps its message, in Hebrew that agrees", () => {
  it("rejected: one message (the control), and with the generator down the fallback says what was not done", async () => {
    rowIs({ ...CUSTOMER_ROW, tool: "update_contact" });
    await request(app).post("/api/approvals/ap_c1/reject").send({ decisionReason: "x" });
    expect(mocks.outgoingAdd).toHaveBeenCalledTimes(1);
    const body = mocks.prisma.message.create.mock.calls[0][0].data.body;
    expect(body).toBe("הבקשה לא אושרה ולכן הפעולה לא בוצעה. אפשר לבדוק יחד אפשרות אחרת.");
  });

  it("a cancellation keeps the masculine verb (הביטול לא בוצע)", async () => {
    rowIs(CUSTOMER_ROW);
    await request(app).post("/api/approvals/ap_c1/reject").send({ decisionReason: "x" });
    expect(mocks.prisma.message.create.mock.calls[0][0].data.body).toBe("הבקשה לא אושרה ולכן הביטול לא בוצע. אפשר לבדוק יחד אפשרות אחרת.");
  });
});
