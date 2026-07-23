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
      updateMany: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
      delete: vi.fn(),
    },
    identity: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
    },
    departmentMember: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
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
    // Pass-through: the guard escape hatch just runs its thunk in tests.
    withCrossTenantAccess: (fn: any) => fn(),
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
    requirePermission: (..._keys: string[]) => (_req: any, _res: any, next: any) => next(),
    requirePermissionOrRole: (..._args: string[]) => (_req: any, _res: any, next: any) => next(),
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
    setIdentityActive: vi.fn().mockResolvedValue(undefined),
    getUserLastLogin: vi.fn().mockResolvedValue(null),
    getLastLoginBySubject: vi.fn().mockResolvedValue(null),
    terminateAllUserSessions: vi.fn().mockResolvedValue(0),
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
import { prisma, ensureIdentity, createRecoveryLink, getUserLastLogin } from "@chatcenter/shared";

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
        identityId: "idn-1",
        isActive: true,
        createdAt: new Date(),
      });
      (prisma.departmentMember.findFirst as any).mockResolvedValue(null);
      (prisma.tenant.findUnique as any).mockResolvedValue({ status: "ACTIVE", name: "Acme" });
      // Memberships list: this identity belongs to one tenant.
      (prisma.user.findMany as any).mockResolvedValue([
        {
          id: "user-1", role: "ADMIN", lastActiveAt: null, createdAt: new Date(),
          tenant: { id: "tenant-1", name: "Acme", slug: "acme", status: "ACTIVE", isActive: true },
        },
      ]);

      const res = await request(createTestApp()).get("/api/auth/me");

      expect(res.status).toBe(200);
      expect(res.body.user.email).toBe("admin@test.com");
      expect(res.body.tenantStatus).toBe("ACTIVE");
      expect(res.body.memberships).toHaveLength(1);
      expect(res.body.memberships[0].tenant.id).toBe("tenant-1");
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
      // No local Identity exists yet - a fresh one is created.
      (prisma.identity.findUnique as any).mockResolvedValue(null);
      (prisma.identity.create as any).mockResolvedValue({ id: "idn-2", authentikSubject: "uuid-123" });
      (prisma.user.create as any).mockResolvedValue({
        id: "user-2", email: "new@test.com", name: "New", role: "AGENT", tenantId: "tenant-1",
      });
      (createRecoveryLink as any).mockResolvedValue("https://auth.example/flow/abc");

      const res = await request(createTestApp())
        .post("/api/agents")
        .send({ email: "new@test.com", name: "New" });

      expect(res.status).toBe(201);
      expect(res.body.setupLink).toBe("https://auth.example/flow/abc");

      // The membership row links the identity and carries no password and no
      // subject of its own (the subject lives on the Identity row).
      const created = (prisma.user.create as any).mock.calls[0][0].data;
      expect(created.identityId).toBe("idn-2");
      expect(created.authentikSubject).toBeUndefined();
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

    it("adds a MEMBERSHIP when the identity already exists in another tenant", async () => {
      (prisma.user.findFirst as any).mockResolvedValue(null);
      (ensureIdentity as any).mockResolvedValue({
        subject: "uuid-taken", pk: 9, email: "shared@test.com", username: "shared@test.com",
      });
      // The identity exists locally (belongs to tenant-9)...
      (prisma.identity.findUnique as any).mockResolvedValue({ id: "idn-9", authentikSubject: "uuid-taken" });
      // ...but has NO membership in tenant-1 yet.
      (prisma.user.findUnique as any).mockResolvedValue(null);
      (prisma.user.create as any).mockResolvedValue({
        id: "user-3", email: "shared@test.com", name: "Shared", role: "AGENT", tenantId: "tenant-1",
      });
      // The person has signed in before - no password-setup link is minted.
      (getUserLastLogin as any).mockResolvedValue("2026-07-01T00:00:00Z");

      const res = await request(createTestApp())
        .post("/api/agents")
        .send({ email: "shared@test.com", name: "Shared" });

      expect(res.status).toBe(201);
      expect(res.body.setupLink).toBeNull();
      expect(res.body.existingIdentity).toBe(true);
      const created = (prisma.user.create as any).mock.calls[0][0].data;
      expect(created.identityId).toBe("idn-9");
    });

    it("refuses a second membership for the same identity in the SAME tenant", async () => {
      (prisma.user.findFirst as any).mockResolvedValue(null);
      (ensureIdentity as any).mockResolvedValue({
        subject: "uuid-taken", pk: 9, email: "shared@test.com", username: "shared@test.com",
      });
      (prisma.identity.findUnique as any).mockResolvedValue({ id: "idn-9", authentikSubject: "uuid-taken" });
      // Already a member of tenant-1.
      (prisma.user.findUnique as any).mockResolvedValue({ id: "existing-member" });

      const res = await request(createTestApp())
        .post("/api/agents")
        .send({ email: "shared@test.com", name: "Shared" });

      expect(res.status).toBe(409); // duplicate membership is a CONFLICT, not a server error
      expect(prisma.user.create).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/agents", () => {
    it("should list agents", async () => {
      (prisma.user.findMany as any).mockResolvedValue([
        { id: "a1", name: "Agent 1", email: "a1@test.com", isActive: true, createdAt: new Date(), _count: { conversations: 2 }, departmentMembers: [] },
      ]);

      const app = createTestApp();
      const res = await request(app).get("/api/agents");

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body[0].name).toBe("Agent 1");
    });
  });
});
