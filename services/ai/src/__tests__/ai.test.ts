import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../services/ai-assist.service", () => ({
  getEffectiveCopilotConfig: vi.fn().mockResolvedValue({
    copilotMode: "READY_MESSAGE",
    model: "gpt-4o-mini",
    systemPrompt: "test",
  }),
  getSuggestions: vi.fn().mockResolvedValue([
    { id: "s1", text: "Thanks for reaching out!", confidence: 0.9, type: "reply" },
  ]),
  summarizeConversation: vi.fn().mockResolvedValue("stub summary"),
}));

vi.mock("../services/ai.service", () => ({
  generateResponse: vi.fn().mockResolvedValue({
    content: JSON.stringify({
      summary: "stub summary",
      suggestions: ["Thanks for reaching out", "How can I help?", "One moment please"],
    }),
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  }),
  getDefaultModel: vi.fn().mockReturnValue("gpt-4o-mini"),
}));

vi.mock("@chatcenter/shared", () => {
  const mockPrisma = {
    conversation: { findFirst: vi.fn() },
    message: { findMany: vi.fn() },
    aIAgent: { findMany: vi.fn().mockResolvedValue([]) },
    businessPolicy: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn() },
  };
  const passthrough = (_req: any, _res: any, next: any) => next();
  const factory = () => passthrough;

  return {
    prisma: mockPrisma,
    authenticate: (req: any, _res: any, next: any) => {
      req.user = { userId: "user-1", tenantId: "tenant-1", role: "ADMIN", email: "admin@test.com" };
      req.tenantId = "tenant-1";
      next();
    },
    resolveTenant: (req: any, _res: any, next: any) => {
      req.tenantId = req.tenantId || "tenant-1";
      next();
    },
    requireActiveTenant: factory,
    requireRole: () => passthrough,
    requireSystemAdmin: passthrough,
    createServiceApp: (config: any) => {
      const app = express();
      app.use(express.json());
      app.get("/health", (_req, res) => res.json({ status: "ok", service: config.name }));
      return app;
    },
    startService: vi.fn(),
  };
});

import aiRoutes from "../routes/ai-assist";
import { prisma } from "@chatcenter/shared";

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/ai-assist", aiRoutes);
  return app;
}

describe("AI Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /api/ai-assist/:conversationId/suggestions", () => {
    it("should return AI suggestions for a conversation", async () => {
      (prisma.conversation.findFirst as any).mockResolvedValue({
        id: "c1", tenantId: "tenant-1", customerName: "John",
      });
      (prisma.message.findMany as any).mockResolvedValue([
        { direction: "INBOUND", body: "Hello", senderName: "John", createdAt: new Date() },
      ]);

      const app = createTestApp();
      const res = await request(app).get("/api/ai-assist/c1/suggestions");

      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it("should return 404 for non-existent conversation", async () => {
      (prisma.conversation.findFirst as any).mockResolvedValue(null);

      const app = createTestApp();
      const res = await request(app).get("/api/ai-assist/nonexistent/suggestions");

      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/ai-assist/:conversationId/summary", () => {
    it("should return AI summary for a conversation", async () => {
      (prisma.conversation.findFirst as any).mockResolvedValue({
        id: "c1", tenantId: "tenant-1", customerName: "John",
      });
      (prisma.message.findMany as any).mockResolvedValue([
        { direction: "INBOUND", body: "I need help", senderName: "John", createdAt: new Date() },
      ]);

      const app = createTestApp();
      const res = await request(app).get("/api/ai-assist/c1/summary");

      expect(res.status).toBe(200);
      expect(res.body.data.summary).toBeDefined();
    });
  });
});
