import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";

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
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([
        {
          id: "a1",
          action: "action.send_message",
          metadata: { blocked: true, reason: "high-risk action requires approval" },
          createdAt: new Date(),
        },
        {
          id: "a2",
          action: "action.tag_contact",
          metadata: { blocked: false },
          createdAt: new Date(),
        },
      ]),
    },
    contact: { findUnique: vi.fn(), update: vi.fn() },
  },
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { id: "u1" };
    next();
  },
  resolveTenant: (req: any, _res: any, next: any) => {
    req.tenantId = "t1";
    next();
  },
  requireActiveTenant: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../services/ai.service", () => ({
  generateResponse: vi.fn().mockResolvedValue({
    content: JSON.stringify({
      summary: "tag customer",
      steps: [
        { tool: "tag_contact", params: { contactId: "c1", tags: ["vip"] }, reason: "segment", riskLevel: "low" },
      ],
      requiresApproval: false,
    }),
    usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
  }),
}));

vi.mock("../services/action-executor.service", () => ({
  executeAction: vi.fn().mockResolvedValue({ tool: "tag_contact", ok: true, output: { id: "c1" } }),
}));

import actionPlannerRoutes from "../routes/action-planner";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/action-planner", actionPlannerRoutes);
  return app;
}

describe("action-planner routes", () => {
  it("plan returns parsed ExecutionPlan", async () => {
    const res = await request(makeApp()).post("/api/action-planner/plan").send({ prompt: "tag c1 vip" });
    expect(res.status).toBe(200);
    expect(res.body.plan.steps).toHaveLength(1);
    expect(res.body.plan.requiresApproval).toBe(false);
  });

  it("plan rejects missing prompt", async () => {
    const res = await request(makeApp()).post("/api/action-planner/plan").send({});
    expect(res.status).toBe(400);
  });

  it("approvals endpoint filters only blocked high-risk entries", async () => {
    const res = await request(makeApp()).get("/api/action-planner/approvals");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe("a1");
  });

  it("execute runs planned steps through executor", async () => {
    const res = await request(makeApp())
      .post("/api/action-planner/execute")
      .send({
        plan: {
          steps: [
            { tool: "tag_contact", params: { contactId: "c1", tags: ["x"] }, reason: "t", riskLevel: "low" },
          ],
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].ok).toBe(true);
  });
});
