/**
 * Rejecting an approval is a DECISION the customer must hear about.
 *
 * The old reject route did two things wrong, and they compounded. It sent the
 * customer nothing at all, and it set `handledBy:"human", isHandedOver:true`
 * on the way out. So from the customer's side a declined cancellation was
 * indistinguishable from being ignored: no reply, and the bot that had said
 * "I'm handling your cancellation now" simply went quiet while the request sat
 * in a human queue nobody had been told to watch.
 *
 * Both halves are locked here:
 *   - exactly one customer continuation, claimed for the "rejected" outcome
 *   - the AI keeps the conversation; a "no" is not an incident
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    rejectRequest: vi.fn(),
    claimCustomerNotification: vi.fn(),
    linkCustomerMessage: vi.fn(),
    outgoingAdd: vi.fn(),
    prisma: {
      approvalRequest: { findFirst: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      conversation: { findFirst: vi.fn(), update: vi.fn() },
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
  approveRequest: vi.fn(),
  rejectRequest: (...a: any[]) => mocks.rejectRequest(...a),
  claimForExecution: vi.fn(),
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

const PENDING_ROW = {
  id: "ap_r1",
  tenantId: "tenant_1",
  conversationId: "conv_1",
  tool: "shopify.cancel_order",
  params: { order_name: "#1009" },
  status: "PENDING",
  requestedBy: "ai-agent:agent_1",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.approvalRequest.findFirst.mockResolvedValue(PENDING_ROW);
  mocks.rejectRequest.mockResolvedValue({ ...PENDING_ROW, status: "REJECTED" });
  mocks.claimCustomerNotification.mockResolvedValue(true);
  mocks.prisma.conversation.findFirst.mockResolvedValue({
    id: "conv_1",
    channel: "WHATSAPP",
    channelAccountId: "acct_1",
    customerExternalId: "972545680665",
    customerName: "Matan Amran",
    assignedAiAgentId: "agent_1",
    isHandedOver: false,
    assignedAgentId: null,
  });
  mocks.prisma.conversation.update.mockResolvedValue({});
  mocks.prisma.message.create.mockResolvedValue({ id: "msg_r1" });
  mocks.prisma.message.findMany.mockResolvedValue([{ body: "אני רוצה לבטל את ההזמנה" }]);
  // The AI service generates the customer-facing wording.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ reply: "הבקשה לביטול לא אושרה ולכן ההזמנה לא בוטלה.", grounded: true }),
    })),
  );
});

describe("POST /api/approvals/:id/reject", () => {
  it("claims the continuation for the REJECTED outcome and sends exactly one message", async () => {
    const res = await request(app)
      .post("/api/approvals/ap_r1/reject")
      .send({ decisionReason: "not eligible" });

    expect(res.status).toBe(200);
    expect(mocks.claimCustomerNotification).toHaveBeenCalledWith("tenant_1", "ap_r1", "rejected");
    expect(mocks.prisma.message.create).toHaveBeenCalledTimes(1);
    expect(mocks.outgoingAdd).toHaveBeenCalledTimes(1);

    const created = mocks.prisma.message.create.mock.calls[0][0].data;
    expect(created.direction).toBe("OUTBOUND");
    expect(created.metadata).toMatchObject({ source: "approval_continuation", outcome: "rejected" });
    // Audit trail: the message that carried the decision is linked to the row.
    expect(mocks.linkCustomerMessage).toHaveBeenCalledWith("tenant_1", "ap_r1", "msg_r1");
  });

  it("leaves the conversation with the AI - a rejection is not a handoff", async () => {
    await request(app).post("/api/approvals/ap_r1/reject").send({ decisionReason: "not eligible" });

    expect(mocks.prisma.conversation.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ isHandedOver: true }) }),
    );
    expect(mocks.prisma.conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ handledBy: "ai_agent" }) }),
    );
  });

  it("does not resume the bot on a conversation a human has taken over", async () => {
    mocks.prisma.conversation.findFirst.mockResolvedValue({
      id: "conv_1",
      channel: "WHATSAPP",
      channelAccountId: "acct_1",
      customerExternalId: "972545680665",
      assignedAiAgentId: "agent_1",
      isHandedOver: true,
      assignedAgentId: "user_7",
    });

    await request(app).post("/api/approvals/ap_r1/reject").send({ decisionReason: "no" });

    expect(mocks.prisma.conversation.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ handledBy: "ai_agent" }) }),
    );
  });

  it("a lost decision race sends nothing and reports the conflict", async () => {
    // Someone already decided this one. Rejecting again must not mint a
    // second customer message contradicting the first.
    mocks.rejectRequest.mockResolvedValue(null);
    mocks.prisma.approvalRequest.findFirst
      .mockResolvedValueOnce(PENDING_ROW)
      .mockResolvedValueOnce({ status: "APPROVED" });

    const res = await request(app)
      .post("/api/approvals/ap_r1/reject")
      .send({ decisionReason: "too late" });

    expect(res.status).toBe(409);
    expect(mocks.claimCustomerNotification).not.toHaveBeenCalled();
    expect(mocks.outgoingAdd).not.toHaveBeenCalled();
  });

  it("a repeated rejection cannot double-notify (the claim is the guard)", async () => {
    mocks.claimCustomerNotification.mockResolvedValue(false);

    await request(app).post("/api/approvals/ap_r1/reject").send({ decisionReason: "no" });

    expect(mocks.prisma.message.create).not.toHaveBeenCalled();
    expect(mocks.outgoingAdd).not.toHaveBeenCalled();
  });

  it("still requires a reason - no silent no", async () => {
    const res = await request(app).post("/api/approvals/ap_r1/reject").send({});
    expect(res.status).toBe(400);
  });
});
