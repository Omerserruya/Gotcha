/**
 * G7 (2026-10-09). Home stores requestedBy as "user:<id>" while the approve
 * route compared it with the bare actor id, so the self-approval guard never
 * fired. Decision: the asker MAY approve their own operator plan (Home /
 * command bar / propose_plan); every other approval they raised is refused.
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
  // The acting user is "mgr_1" for every request in this file.
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

const BASE = {
  id: "ap_1",
  tenantId: "tenant_1",
  conversationId: "conv_1",
  status: "PENDING",
  expiresAt: new Date(Date.now() + 3600_000),
  riskLevel: "low",
};
// Exactly what services/ai system-tools writes for a Home plan.
const HOME_PLAN = {
  ...BASE,
  tool: "propose_plan",
  params: { summary: "assign", steps: [], requester: { userId: "mgr_1", name: "Mgr" }, source: "home_assistant" },
  requestedBy: "user:mgr_1",
};
// Not an operator plan: no propose_plan, no operator source.
const OWN_ACTION = { ...BASE, tool: "update_contact", params: { contactId: "c_1", name: "X" }, requestedBy: "user:mgr_1" };

const REFUSED = { error: "approver must be a different actor than the requester" };

function rowIs(row: any) {
  mocks.prisma.approvalRequest.findFirst.mockResolvedValue(row);
  mocks.rejectRequest.mockResolvedValue({ ...row, status: "REJECTED" });
  mocks.approveRequest.mockResolvedValue({ ...row, status: "APPROVED" });
}

const approve = () => request(app).post("/api/approvals/ap_1/approve").send({});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.claimCustomerNotification.mockResolvedValue(true);
  mocks.claimForExecution.mockResolvedValue(true);
  mocks.prisma.conversation.findFirst.mockResolvedValue({
    id: "conv_1", channel: "WHATSAPP", channelAccountId: "acct_1", customerExternalId: "972500000000",
    customerName: "C", assignedAiAgentId: "agent_1", isHandedOver: false, assignedAgentId: null,
  });
  mocks.prisma.conversation.update.mockResolvedValue({});
  mocks.prisma.conversation.updateMany.mockResolvedValue({ count: 1 });
  mocks.prisma.message.create.mockResolvedValue({ id: "msg_1" });
  mocks.prisma.message.findMany.mockResolvedValue([]);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (String(url).includes("/grounded") || String(url).includes("/continuation")) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ data: { ok: true } }) };
  }));
});

describe("G7: the asker may approve their own operator plan", () => {
  it("a Home plan (requestedBy user:<self>) is approved and dispatched", async () => {
    rowIs(HOME_PLAN);
    const r = await approve();
    expect(r.status).toBe(200);
    expect(mocks.approveRequest).toHaveBeenCalledTimes(1);
    expect(mocks.approveRequest.mock.calls[0][2]).toBe("mgr_1");
  });

  it("a command-bar action of any tool is an operator plan too", async () => {
    rowIs({ ...OWN_ACTION, params: { ...OWN_ACTION.params, source: "command_bar" } });
    const r = await approve();
    expect(r.status).toBe(200);
    expect(mocks.approveRequest).toHaveBeenCalledTimes(1);
  });
});

describe("G7: a non-plan approval the user raised themselves is refused", () => {
  it("requestedBy user:<self>: 403 with the guard's body, nothing decided", async () => {
    rowIs(OWN_ACTION);
    const r = await approve();
    expect(r.status).toBe(403);
    expect(r.body).toEqual(REFUSED);
    expect(mocks.approveRequest).not.toHaveBeenCalled();
    expect(mocks.claimForExecution).not.toHaveBeenCalled();
  });

  it("requestedBy bare <self>: refused the same way", async () => {
    rowIs({ ...OWN_ACTION, requestedBy: "mgr_1" });
    const r = await approve();
    expect(r.status).toBe(403);
    expect(r.body).toEqual(REFUSED);
    expect(mocks.approveRequest).not.toHaveBeenCalled();
  });

  it("requestedBy agent:<self> (a human's commerce request): refused the same way", async () => {
    rowIs({ ...OWN_ACTION, tool: "shopify.refund_order", params: { orderId: "o_1" }, requestedBy: "agent:mgr_1" });
    const r = await approve();
    expect(r.status).toBe(403);
    expect(r.body).toEqual(REFUSED);
    expect(mocks.approveRequest).not.toHaveBeenCalled();
  });

  it("an AI agent's prefix is not a person: 'agent-loop:mgr_1' is not mgr_1", async () => {
    for (const requestedBy of ["agent-loop:mgr_1", "agent-mgr_1"]) {
      rowIs({ ...OWN_ACTION, requestedBy });
      const r = await approve();
      expect(r.status).toBe(200);
    }
  });

  it("a prefix only at the start counts: 'xuser:mgr_1' is not mgr_1", async () => {
    rowIs({ ...OWN_ACTION, requestedBy: "xuser:mgr_1" });
    const r = await approve();
    expect(r.status).toBe(200);
  });
});

describe("G7: someone else approving still works", () => {
  it.each([
    ["user:other_1", OWN_ACTION],
    ["other_1", OWN_ACTION],
    ["ai-agent:agent_1", OWN_ACTION],
    ["agent:other_1", OWN_ACTION],
    ["user:other_1", HOME_PLAN],
  ])("requestedBy %s is approved by mgr_1", async (requestedBy, row) => {
    rowIs({ ...row, requestedBy });
    const r = await approve();
    expect(r.status).toBe(200);
    expect(mocks.approveRequest).toHaveBeenCalledTimes(1);
  });
});
