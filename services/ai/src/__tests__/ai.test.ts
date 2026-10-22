import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../services/ai-assist.service", () => ({
  getEffectiveCopilotConfig: vi.fn().mockResolvedValue({
    copilotMode: "READY_MESSAGE",
    model: "gpt-4o-mini",
    isActive: true,
    agent: { name: "Test Agent", role: "customer_support", description: null, tone: "professional" },
    tools: [],
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

// Spread the real module and override only what this test needs: the DB, Redis,
// and the middlewares that stand between a request and the handlers under test.
vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const mockPrisma = {
    conversation: { findFirst: vi.fn() },
    message: { findMany: vi.fn(), findFirst: vi.fn().mockResolvedValue(null) },
    aIAgent: { findMany: vi.fn().mockResolvedValue([]) },
    businessPolicy: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn() },
  };
  // Suggestions are read from Redis (copilot-suggestions.service), never
  // generated on a GET. The fake holds one stored generation for "c1".
  const store = new Map<string, string>([
    ["copilot:suggestions:tenant-1:c1", JSON.stringify({
      suggestions: [{ id: "s1", text: "Thanks for reaching out!", confidence: 0.9, type: "reply" }],
      copilotMode: "READY_MESSAGE",
      basedOnMessageId: null,
      generatedAt: new Date(0).toISOString(),
      trigger: "inbound",
    })],
  ]);
  const fakeRedis = {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async () => "OK"),
    ttl: vi.fn(async () => -1),
    incr: vi.fn(async () => 1),
    expire: vi.fn(async () => 1),
  };
  const passthrough = (_req: any, _res: any, next: any) => next();
  const factory = () => passthrough;

  return {
    ...actual,
    prisma: mockPrisma,
    getRedis: () => fakeRedis,
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
    requireInternalKey: passthrough,
    requireEntitlement: factory,
    // A router.param handler: (req, res, next, id). Visibility is not under
    // test here; the handlers' own not-found path is.
    requireVisibleConversation: (_req: any, _res: any, next: any) => next(),
    resolveConversationLocale: vi.fn().mockResolvedValue({ effective: "en" }),
    resolveEffectiveLocale: vi.fn().mockResolvedValue({ effective: "en" }),
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
