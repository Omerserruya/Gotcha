import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

// Mock shared package
vi.mock("@chatcenter/shared", () => {
  const mockPrisma = {
    tenant: {
      findUnique: vi.fn(),
    },
    user: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
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
    validate: (_schema: any) => (_req: any, _res: any, next: any) => next(),
    signToken: vi.fn().mockReturnValue("mock-token"),
    verifyToken: vi.fn().mockReturnValue({ userId: "user-1", tenantId: "tenant-1", role: "ADMIN", email: "admin@test.com" }),
    createServiceApp: (config: any) => {
      const app = express();
      app.use(express.json());
      app.get("/health", (_req, res) => res.json({ status: "ok", service: config.name }));
      return app;
    },
    startService: vi.fn(),
  };
});

import authRoutes from "../routes/auth";
import agentRoutes from "../routes/agents";
import { prisma } from "@chatcenter/shared";

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRoutes);
  app.use("/api/agents", agentRoutes);
  return app;
}

describe("Auth Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("POST /api/auth/login", () => {
    it("should return 404 if tenant not found", async () => {
      (prisma.tenant.findUnique as any).mockResolvedValue(null);

      const app = createTestApp();
      const res = await request(app)
        .post("/api/auth/login")
        .send({ email: "test@test.com", password: "password", tenantSlug: "unknown" });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Tenant not found");
    });

    it("should return token on valid login", async () => {
      const mockTenant = { id: "tenant-1", slug: "demo" };
      (prisma.tenant.findUnique as any).mockResolvedValue(mockTenant);

      // Mock the auth service indirectly via the service module
      const bcrypt = await import("bcryptjs");
      const hashedPw = await bcrypt.hash("password123", 10);
      (prisma.user.findFirst as any).mockResolvedValue({
        id: "user-1", tenantId: "tenant-1", email: "test@test.com",
        password: hashedPw, name: "Test", role: "ADMIN", isActive: true,
      });

      const app = createTestApp();
      const res = await request(app)
        .post("/api/auth/login")
        .send({ email: "test@test.com", password: "password123", tenantSlug: "demo" });

      expect(res.status).toBe(200);
      expect(res.body.token).toBeDefined();
    });
  });

  describe("POST /api/auth/register", () => {
    it("should return 404 if tenant not found", async () => {
      (prisma.tenant.findUnique as any).mockResolvedValue(null);

      const app = createTestApp();
      const res = await request(app)
        .post("/api/auth/register")
        .send({ email: "new@test.com", password: "password123", name: "New User", tenantSlug: "unknown" });

      expect(res.status).toBe(404);
    });

    it("should create user for valid tenant", async () => {
      const mockTenant = { id: "tenant-1", slug: "demo" };
      (prisma.tenant.findUnique as any).mockResolvedValue(mockTenant);
      (prisma.user.findFirst as any).mockResolvedValue(null); // No existing user
      (prisma.user.create as any).mockResolvedValue({
        id: "user-2", tenantId: "tenant-1", email: "new@test.com",
        name: "New User", role: "AGENT",
      });

      const app = createTestApp();
      const res = await request(app)
        .post("/api/auth/register")
        .send({ email: "new@test.com", password: "password123", name: "New User", tenantSlug: "demo" });

      expect(res.status).toBe(201);
      expect(res.body.token).toBeDefined();
    });
  });

  describe("GET /api/agents", () => {
    it("should list agents", async () => {
      (prisma.user.findMany as any).mockResolvedValue([
        { id: "a1", name: "Agent 1", email: "a1@test.com", isActive: true, createdAt: new Date(), _count: { conversations: 2 } },
      ]);

      const app = createTestApp();
      const res = await request(app).get("/api/agents");

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body[0].name).toBe("Agent 1");
    });
  });
});
