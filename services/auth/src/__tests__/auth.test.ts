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
    departmentMember: {
      findUnique: vi.fn(),
    },
    conversation: {
      updateMany: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
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
    enforceMfaEnrollment: () => (_req: any, _res: any, next: any) => next(),
    validate: (_schema: any) => (_req: any, _res: any, next: any) => next(),
    resolveEffectiveLocale: vi.fn().mockReturnValue("en"),
    isSupportedLocale: vi.fn().mockReturnValue(true),
    SUPPORTED_LOCALES: ["en", "he"],
    getRedis: vi.fn(),
    // The Authentik admin client is the only identity surface GOTCHA calls.
    ensureIdentity: vi.fn(),
    createRecoveryLink: vi.fn(),
    deactivateIdentity: vi.fn(),
    deleteIdentity: vi.fn(),
    updateIdentity: vi.fn().mockResolvedValue(undefined),
    findIdentityBySubject: vi.fn(),
    // Shared audit primitive (fire-safe): no-op in tests.
    writeAudit: vi.fn().mockResolvedValue(undefined),
    auditUser: vi.fn().mockResolvedValue(undefined),
    auditSystem: vi.fn().mockResolvedValue(undefined),
    AuditAction: new Proxy({}, { get: (_t, prop) => String(prop) }),
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
import { prisma, ensureIdentity, createRecoveryLink } from "@chatcenter/shared";

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

  // The point of the Authentik migration: GOTCHA exposes no endpoint that
  // accepts, sets, or resets a credential. These assert that absence, so the
  // endpoints cannot quietly come back.
  describe("legacy credential endpoints are gone", () => {
    it.each([
      ["/api/auth/login"],
      ["/api/auth/register"],
      ["/api/auth/refresh"],
      ["/api/auth/verify-magic-link"],
      ["/api/auth/change-password"],
      ["/api/auth/forgot-password"],
      ["/api/auth/reset-password"],
    ])("POST %s is not routed", async (path) => {
      const res = await request(createTestApp())
        .post(path)
        .send({ email: "a@b.com", password: "hunter2222" });
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/auth/me", () => {
    it("returns the GOTCHA profile for an authenticated identity", async () => {
      (prisma.user.findUnique as any).mockResolvedValue({
        id: "user-1",
        email: "admin@test.com",
        name: "Admin",
        role: "ADMIN",
        tenantId: "tenant-1",
        isActive: true,
        createdAt: new Date(),
      });
      (prisma.departmentMember.findUnique as any).mockResolvedValue(null);
      (prisma.tenant.findUnique as any).mockResolvedValue({ status: "ACTIVE" });

      const res = await request(createTestApp()).get("/api/auth/me");

      expect(res.status).toBe(200);
      expect(res.body.user.email).toBe("admin@test.com");
      expect(res.body.tenantStatus).toBe("ACTIVE");
      // Nothing credential- or identity-shaped may leave this endpoint.
      expect(res.body.user.password).toBeUndefined();
      expect(res.body.user.authentikSubject).toBeUndefined();
    });

    it("404s when the token resolves to no user", async () => {
      (prisma.user.findUnique as any).mockResolvedValue(null);
      const res = await request(createTestApp()).get("/api/auth/me");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/agents (invitation)", () => {
    it("provisions an Authentik identity and returns a setup link", async () => {
      (prisma.user.findFirst as any).mockResolvedValue(null);
      (prisma.user.findUnique as any).mockResolvedValue(null);
      (ensureIdentity as any).mockResolvedValue({
        subject: "uuid-123", pk: 7, email: "new@test.com", username: "new@test.com",
      });
      (prisma.user.create as any).mockResolvedValue({
        id: "user-2", email: "new@test.com", name: "New", role: "AGENT", tenantId: "tenant-1",
      });
      (createRecoveryLink as any).mockResolvedValue("https://auth.example/flow/abc");

      const res = await request(createTestApp())
        .post("/api/agents")
        .send({ email: "new@test.com", name: "New" });

      expect(res.status).toBe(201);
      expect(res.body.setupLink).toBe("https://auth.example/flow/abc");

      // The local row carries the subject and no password.
      const created = (prisma.user.create as any).mock.calls[0][0].data;
      expect(created.authentikSubject).toBe("uuid-123");
      expect(created.password).toBeUndefined();
    });

    it("rejects a duplicate email in the same tenant", async () => {
      (prisma.user.findFirst as any).mockResolvedValue({ id: "existing" });

      const res = await request(createTestApp())
        .post("/api/agents")
        .send({ email: "dupe@test.com", name: "Dupe" });

      expect(res.status).toBe(409);
      // No identity should be minted for a rejected invite.
      expect(ensureIdentity).not.toHaveBeenCalled();
    });

    it("refuses to link an identity already bound to another account", async () => {
      (prisma.user.findFirst as any).mockResolvedValue(null);
      (ensureIdentity as any).mockResolvedValue({
        subject: "uuid-taken", pk: 9, email: "shared@test.com", username: "shared@test.com",
      });
      // That subject already belongs to a different GOTCHA user.
      (prisma.user.findUnique as any).mockResolvedValue({ id: "other-user", tenantId: "tenant-9" });

      const res = await request(createTestApp())
        .post("/api/agents")
        .send({ email: "shared@test.com", name: "Shared" });

      expect(res.status).toBe(409);
      expect(prisma.user.create).not.toHaveBeenCalled();
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
