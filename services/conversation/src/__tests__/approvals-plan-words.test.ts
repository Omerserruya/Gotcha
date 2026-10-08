/**
 * ★ A plan's words are the reader's, on the approvals API: a step that
 * assigns a conversation reads "you" to its assignee and names the assignee
 * to anyone else. The summary was written for the requester only, so an
 * approver read "assign it to you" about somebody else (2026-10-08). The list
 * and the one-request card say the same; anything that is not a plan is
 * served as stored.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({ viewer: "boss", approvals: [] as any[] }));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: H.viewer, role: "ADMIN" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    prisma: {
      approvalRequest: {
        findFirst: async (a: any) => H.approvals.find((r) => r.id === a.where.id && r.tenantId === a.where.tenantId) ?? null,
        findMany: async () => H.approvals.map((r) => ({ ...r })),
      },
      user: { findMany: async () => [] },
      conversation: { findFirst: async () => null },
      contact: { findFirst: async () => null },
      message: { findMany: async () => [] },
    },
  };
});

import router from "../routes/approvals";

const app = express();
app.use(express.json());
app.use("/api/approvals", router);

const NEUTRAL = "לשייך ל-Matan את השיחה של Omer Serruya (וואטסאפ)";
const TO_YOU = "לשייך אליך את השיחה של Omer Serruya (וואטסאפ)";
const NOTE = "להוסיף הערה ל-Omer Serruya: “VIP”";

beforeEach(() => {
  H.viewer = "boss";
  H.approvals = [
    {
      id: "plan", tenantId: "T", tool: "propose_plan", status: "PENDING", conversationId: null, contactId: null, requestedBy: "user:matan",
      summary: `${NEUTRAL}; ${NOTE}`,
      params: {
        summary: `${NEUTRAL}; ${NOTE}`,
        steps: [
          { tool: "assign_conversation", target: { conversationId: "c1", assigneeId: "matan" }, summary: NEUTRAL, summaryForAssignee: TO_YOU },
          { tool: "add_note", target: { customerId: "omer" }, summary: NOTE },
        ],
      },
    },
    { id: "refund", tenantId: "T", tool: "issue_refund", status: "PENDING", conversationId: null, contactId: null, requestedBy: "bot", summary: "Refund order #1016", params: { amount: 250 } },
  ];
});

describe("★ the approvals API says a plan in the reader's words", () => {
  it("an approver who is not the assignee reads the assignee's name, in the list and on the card", async () => {
    const list = (await request(app).get("/api/approvals")).body.data;
    const plan = list.find((a: any) => a.id === "plan");
    expect(plan.summary).toBe(`${NEUTRAL}; ${NOTE}`);
    expect(plan.params.steps.map((s: any) => s.summary)).toEqual([NEUTRAL, NOTE]);
    const card = (await request(app).get("/api/approvals/plan")).body.approval;
    expect(card.summary).toBe(`${NEUTRAL}; ${NOTE}`);
  });

  it("the assignee reads 'you', in the list, the steps, the plan's own summary and the card", async () => {
    H.viewer = "matan";
    const plan = (await request(app).get("/api/approvals")).body.data.find((a: any) => a.id === "plan");
    expect(plan.summary).toBe(`${TO_YOU}; ${NOTE}`);
    expect(plan.params.summary).toBe(`${TO_YOU}; ${NOTE}`);
    expect(plan.params.steps.map((s: any) => s.summary)).toEqual([TO_YOU, NOTE]);
    expect((await request(app).get("/api/approvals/plan")).body.approval.summary).toBe(`${TO_YOU}; ${NOTE}`);
  });

  it("anything that is not a plan is served as stored", async () => {
    H.viewer = "matan";
    const refund = (await request(app).get("/api/approvals")).body.data.find((a: any) => a.id === "refund");
    expect(refund).toMatchObject({ summary: "Refund order #1016", params: { amount: 250 } });
  });
});
