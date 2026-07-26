import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("@chatcenter/shared", () => {
  const mockPrisma = {
    chatbotFlow: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
  };

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
    requireRole: (..._roles: string[]) => (_req: any, _res: any, next: any) => next(),
    requirePermissionOrRole: (_perm: string, ..._roles: string[]) => (_req: any, _res: any, next: any) => next(),
    // Plan-entitlement gates. Pass-through here: what they DENY is covered by
    // the resolver's own suite and the billing boundary tests, not by mocking
    // them into always-allow in a route test.
    requireEntitlement: (_feature: string) => (_req: any, _res: any, next: any) => next(),
    requireCapacity: (..._args: any[]) => (_req: any, _res: any, next: any) => next(),
    validate: (_schema: any) => (_req: any, _res: any, next: any) => next(),
    createServiceApp: (config: any) => {
      const app = express();
      app.use(express.json());
      app.get("/health", (_req, res) => res.json({ status: "ok", service: config.name }));
      return app;
    },
    startService: vi.fn(),
  };
});

import chatbotRoutes from "../routes/chatbot";
import { prisma } from "@chatcenter/shared";

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/chatbot-flows", chatbotRoutes);
  return app;
}

describe("Chatbot Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /api/chatbot-flows", () => {
    it("should list all flows for tenant", async () => {
      const mockFlows = [
        { id: "f1", name: "Welcome Flow", isActive: true, tenantId: "tenant-1" },
      ];
      (prisma.chatbotFlow.findMany as any).mockResolvedValue(mockFlows);

      const app = createTestApp();
      const res = await request(app).get("/api/chatbot-flows");

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].name).toBe("Welcome Flow");
    });
  });

  describe("GET /api/chatbot-flows/:id", () => {
    it("should return a flow by ID", async () => {
      (prisma.chatbotFlow.findFirst as any).mockResolvedValue({
        id: "f1", name: "Welcome Flow", nodes: [], edges: [],
      });

      const app = createTestApp();
      const res = await request(app).get("/api/chatbot-flows/f1");

      expect(res.status).toBe(200);
      expect(res.body.id).toBe("f1");
    });

    it("should return 404 for non-existent flow", async () => {
      (prisma.chatbotFlow.findFirst as any).mockResolvedValue(null);

      const app = createTestApp();
      const res = await request(app).get("/api/chatbot-flows/nonexistent");

      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/chatbot-flows", () => {
    it("should create a new flow", async () => {
      (prisma.chatbotFlow.create as any).mockResolvedValue({
        id: "f2", name: "New Flow", tenantId: "tenant-1", nodes: [], edges: [], isActive: false,
      });

      const app = createTestApp();
      const res = await request(app)
        .post("/api/chatbot-flows")
        .send({ name: "New Flow", nodes: [], edges: [] });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe("New Flow");
    });
  });

  describe("DELETE /api/chatbot-flows/:id", () => {
    it("should delete an existing flow", async () => {
      (prisma.chatbotFlow.findFirst as any).mockResolvedValue({ id: "f1" });
      (prisma.chatbotFlow.delete as any).mockResolvedValue({ id: "f1" });

      const app = createTestApp();
      const res = await request(app).delete("/api/chatbot-flows/f1");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe("POST /api/chatbot-flows/:id/activate", () => {
    // A VALID process graph (§3): publishing requires it to pass the
    // authoritative validator (start → step → end).
    const validGraph = {
      nodes: [
        { id: "s", type: "start" },
        { id: "m", type: "send_message_text", data: { text: "hi" } },
        { id: "e", type: "end" },
      ],
      edges: [
        { source: "s", target: "m" },
        { source: "m", target: "e" },
      ],
    };

    it("should activate a valid flow", async () => {
      (prisma.chatbotFlow.findFirst as any).mockResolvedValue({ id: "f1", ...validGraph });
      (prisma.chatbotFlow.update as any).mockResolvedValue({ id: "f1", isActive: true });

      const app = createTestApp();
      const res = await request(app).post("/api/chatbot-flows/f1/activate");

      expect(res.status).toBe(200);
      expect(res.body.isActive).toBe(true);
    });

    it("§3 blocks publishing an invalid graph with 422 + errors", async () => {
      (prisma.chatbotFlow.findFirst as any).mockResolvedValue({ id: "f1", nodes: [], edges: [] });
      const app = createTestApp();
      const res = await request(app).post("/api/chatbot-flows/f1/activate");

      expect(res.status).toBe(422);
      expect(res.body.error).toBe("validation_failed");
      expect(Array.isArray(res.body.errors)).toBe(true);
      expect(res.body.errors.length).toBeGreaterThan(0);
    });
  });
});
