import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("@chatcenter/shared", () => {
  const mockPrisma = {
    conversation: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    message: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    user: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    tenant: {
      findUnique: vi.fn(),
    },
    $transaction: vi.fn((fn: any) => fn({
      message: { create: vi.fn().mockResolvedValue({ id: "msg-1", createdAt: new Date() }) },
      conversation: { update: vi.fn() },
    })),
  };

  return {
    prisma: mockPrisma,
    // Opening a chosen conversation reads through the historical scope, so
    // imported threads are not blanked once an agent clicks into one. The
    // real implementation is a scope wrapper; here it just runs the callback.
    withHistoricalRecords: <T,>(fn: () => Promise<T>) => fn(),
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
    requireActiveTenant: () => (_req: any, _res: any, next: any) => next(),
    validate: (_schema: any) => (_req: any, _res: any, next: any) => next(),
    verifyToken: vi.fn(),
    getInternalServiceKey: () => "test-internal-key",
    verifyInternalServiceKey: () => true,
    getRedis: () => ({ get: vi.fn(), set: vi.fn(), del: vi.fn(), publish: vi.fn() }),
    writeAudit: vi.fn().mockResolvedValue(undefined),
    auditUser: vi.fn().mockResolvedValue(undefined),
    AuditAction: new Proxy({}, { get: (_t, p) => String(p) }),
    publishEvent: vi.fn().mockResolvedValue(undefined),
    outgoingMessageQueue: { add: vi.fn().mockResolvedValue(undefined) },
    createServiceApp: (config: any) => {
      const app = express();
      app.use(express.json());
      app.get("/health", (_req, res) => res.json({ status: "ok", service: config.name }));
      return app;
    },
    startService: vi.fn(),
    subscribeToEvents: vi.fn(),
  };
});

vi.mock("../lib/socket", () => ({
  initSocket: vi.fn(),
  getIO: vi.fn(() => ({ to: () => ({ emit: vi.fn() }) })),
}));

import conversationRoutes from "../routes/conversations";
import messageRoutes from "../routes/messages";
import { prisma } from "@chatcenter/shared";

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/conversations", conversationRoutes);
  app.use("/api/conversations", messageRoutes);
  return app;
}

describe("Conversation Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /api/conversations", () => {
    it("should list conversations with pagination", async () => {
      const mockConvos = [
        { id: "c1", customerExternalId: "+123", status: "OPEN", assignedAgent: null, messages: [], _count: { messages: 3 } },
      ];
      (prisma.conversation.findMany as any).mockResolvedValue(mockConvos);
      (prisma.conversation.count as any).mockResolvedValue(1);

      const app = createTestApp();
      const res = await request(app).get("/api/conversations");

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.meta.total).toBe(1);
    });

    it("should filter by status", async () => {
      (prisma.conversation.findMany as any).mockResolvedValue([]);
      (prisma.conversation.count as any).mockResolvedValue(0);

      const app = createTestApp();
      const res = await request(app).get("/api/conversations?status=OPEN");

      expect(res.status).toBe(200);
      expect(prisma.conversation.findMany).toHaveBeenCalled();
    });
  });

  describe("GET /api/conversations/:id", () => {
    it("should return conversation by ID", async () => {
      const mockConvo = { id: "c1", customerExternalId: "+123", status: "OPEN", messages: [] };
      (prisma.conversation.findFirst as any).mockResolvedValue(mockConvo);

      const app = createTestApp();
      const res = await request(app).get("/api/conversations/c1");

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe("c1");
    });

    it("should return 404 for non-existent conversation", async () => {
      (prisma.conversation.findFirst as any).mockResolvedValue(null);

      const app = createTestApp();
      const res = await request(app).get("/api/conversations/nonexistent");

      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/conversations/:id/claim", () => {
    it("should claim an unassigned conversation", async () => {
      (prisma.conversation.findFirst as any).mockResolvedValue({ id: "c1", assignedAgentId: null });
      (prisma.conversation.update as any).mockResolvedValue({
        id: "c1", assignedAgentId: "user-1", isHandedOver: true,
        assignedAgent: { id: "user-1", name: "Admin", email: "admin@test.com" },
      });

      const app = createTestApp();
      const res = await request(app).post("/api/conversations/c1/claim");

      expect(res.status).toBe(200);
      expect(res.body.data.assignedAgentId).toBe("user-1");
    });
  });

  describe("GET /api/conversations/:conversationId/messages", () => {
    it("should list messages for a conversation", async () => {
      (prisma.message.findMany as any).mockResolvedValue([
        { id: "m1", body: "Hello", direction: "INBOUND" },
      ]);
      (prisma.message.count as any).mockResolvedValue(1);

      const app = createTestApp();
      const res = await request(app).get("/api/conversations/c1/messages");

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });
  });
});
