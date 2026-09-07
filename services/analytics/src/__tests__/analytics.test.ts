import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("@chatcenter/shared", () => {
  const mockRedis = {
    hgetall: vi.fn().mockResolvedValue({ messages_total: "42", messages_inbound: "20", messages_outbound: "22", conversations_closed: "5" }),
    lrange: vi.fn().mockResolvedValue(["1000", "2000", "3000"]),
    hincrby: vi.fn().mockResolvedValue(1),
    lpush: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    set: vi.fn().mockResolvedValue("OK"),
    get: vi.fn().mockResolvedValue(null),
  };

  const mockPrisma = {
    conversation: {
      count: vi.fn().mockResolvedValue(5),
      findMany: vi.fn().mockResolvedValue([]),
    },
    user: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    message: {
      count: vi.fn().mockResolvedValue(11),
      findMany: vi.fn().mockResolvedValue([]),
    },
    approvalRequest: {
      count: vi.fn().mockResolvedValue(3),
    },
  };

  return {
    prisma: mockPrisma,
    getRedis: () => mockRedis,
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
    createWorker: vi.fn(() => ({ on: vi.fn() })),
    createServiceApp: (config: any) => {
      const app = express();
      app.use(express.json());
      app.get("/health", (_req, res) => res.json({ status: "ok", service: config.name }));
      return app;
    },
    startService: vi.fn(),
  };
});

import * as shared from "@chatcenter/shared";
import analyticsRoutes from "../routes/analytics";

/** The mocked prisma.approvalRequest.count, reached through the module mock. */
function prismaCount() {
  return (shared as any).prisma.approvalRequest.count;
}

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/analytics", analyticsRoutes);
  return app;
}

describe("Analytics Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /api/analytics/dashboard", () => {
    it("should return dashboard stats", async () => {
      const app = createTestApp();
      const res = await request(app).get("/api/analytics/dashboard");

      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.activeConversations).toBe(5);
      expect(res.body.data.totalMessagesToday).toBe(42);
      expect(res.body.data.avgResponseTimeMs).toBe(2000);
    });
  });

  describe("GET /api/analytics/hourly", () => {
    it("should return 24 hourly data points", async () => {
      const app = createTestApp();
      const res = await request(app).get("/api/analytics/hourly");

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(24);
    });
  });

  describe("GET /api/analytics/daily", () => {
    it("should return daily volume data", async () => {
      const app = createTestApp();
      const res = await request(app).get("/api/analytics/daily?days=7");

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(7);
    });
  });

  describe("GET /api/analytics/queue", () => {
    it("should return queue depth stats", async () => {
      const app = createTestApp();
      const res = await request(app).get("/api/analytics/queue");

      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.waiting).toBeDefined();
    });
  });

  describe("GET /api/analytics/overview", () => {
    it("carries pendingApprovalCount, the metric strip's fourth figure", async () => {
      const app = createTestApp();
      const res = await request(app).get("/api/analytics/overview");

      expect(res.status).toBe(200);
      expect(res.body.data.pendingApprovalCount).toBe(3);
    });

    it("counts only approvals a human can still act on", async () => {
      // status alone would include rows the expiry sweeper has not reached
      // yet, and the strip would send the operator to a list that disagrees
      // with the number they just clicked.
      const app = createTestApp();
      await request(app).get("/api/analytics/overview");

      const where = (prismaCount() as any).mock.calls[0][0].where;
      expect(where.status).toBe("PENDING");
      expect(where.expiresAt.gt).toBeInstanceOf(Date);
      expect(where.tenantId).toBe("tenant-1");
    });

    it("does not date-range the pending count", async () => {
      // Every other figure describes the window; this one answers "what is
      // waiting on a human right now", and an approval raised before `from`
      // is still waiting.
      const app = createTestApp();
      await request(app).get("/api/analytics/overview?from=2026-09-01&to=2026-09-07");

      const where = (prismaCount() as any).mock.calls[0][0].where;
      expect(where.createdAt).toBeUndefined();
    });
  });
});
