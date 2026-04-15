import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("@chatcenter/shared", () => ({
  prisma: {},
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { id: "u1", role: "ADMIN" };
    next();
  },
  resolveTenant: (req: any, _res: any, next: any) => {
    req.tenantId = "t-policy-routes";
    next();
  },
  requireActiveTenant: () => (_req: any, _res: any, next: any) => next(),
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../services/ai-assist.service", () => ({ getSuggestions: vi.fn() }));
vi.mock("../services/agent-config-generator", () => ({
  generateAllAgentConfigs: vi.fn(),
  generateAgentConfig: vi.fn(),
}));
vi.mock("../services/conversation-intelligence.service", () => ({
  analyzeConversation: vi.fn(),
  getConversationIntelligence: vi.fn(),
  getConversationReplay: vi.fn(),
}));
vi.mock("../services/tool-execution.service", () => ({
  getToolsForTenant: vi.fn(),
  executeTool: vi.fn(),
  getToolExecutions: vi.fn(),
}));
vi.mock("../services/agent-performance.service", () => ({
  scoreAgent: vi.fn(),
  getAgentScore: vi.fn(),
}));
vi.mock("../services/followup-generator.service", () => ({ generateFollowup: vi.fn() }));
vi.mock("../services/customer-state.service", () => ({ buildCustomerState: vi.fn() }));
vi.mock("../services/ai.service", () => ({
  generateResponse: vi.fn(),
  getDefaultModel: () => "gpt-4o-mini",
}));

import aiAssistRoutes from "../routes/ai-assist";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/ai-assist", aiAssistRoutes);
  return app;
}

describe("policy admin routes", () => {
  it("GET /policy returns default policy for new tenant", async () => {
    const res = await request(makeApp()).get("/api/ai-assist/policy");
    expect(res.status).toBe(200);
    expect(res.body.data.maxDiscountPercent).toBe(10);
  });

  it("PUT /policy patches and returns merged policy", async () => {
    const app = makeApp();
    const res = await request(app)
      .put("/api/ai-assist/policy")
      .send({ maxDiscountPercent: 20, blockedTopics: ["crypto"] });
    expect(res.status).toBe(200);
    expect(res.body.data.maxDiscountPercent).toBe(20);
    expect(res.body.data.blockedTopics).toContain("crypto");

    const follow = await request(app).get("/api/ai-assist/policy");
    expect(follow.body.data.maxDiscountPercent).toBe(20);
  });
});
