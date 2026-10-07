/**
 * GET /api/auth/me carries setupAdmin { name } only while the workspace is
 * still being set up (PENDING_ONBOARDING / PENDING_ADMIN_SETUP), so a
 * non-admin's waiting screen can say who is setting it up. Name only - no id,
 * no email - and never once the workspace is ACTIVE.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const DB = vi.hoisted(() => ({ status: "PENDING_ONBOARDING", users: [] as any[] }));
vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "agent1", tenantId: "T", role: "AGENT" }; req.tenantId = "T"; n(); },
    withCrossTenantAccess: (fn: any) => fn(),
    prisma: {
      user: {
        findUnique: async (a: any) => { const u = DB.users.find((x) => x.id === a.where.id); return u ? { ...u } : null; },
        findFirst: async (a: any) => DB.users
          .filter((u) => u.tenantId === a.where.tenantId && u.role === a.where.role && u.isActive === a.where.isActive)
          .sort((x, y) => +x.createdAt - +y.createdAt)
          .map((u) => ({ name: u.name }))[0] ?? null,
        findMany: async () => [],
      },
      departmentMember: { findFirst: async () => null },
      tenant: { findUnique: async () => ({ status: DB.status, name: "Urban Supply" }) },
    },
  };
});

import router from "../routes/auth";
const app = express();
app.use(express.json());
app.use("/api/auth", router);

beforeEach(() => {
  DB.status = "PENDING_ONBOARDING";
  DB.users = [
    { id: "agent1", tenantId: "T", identityId: "i1", email: "agent@x.test", name: "Noa", role: "AGENT", isActive: true, createdAt: new Date(3) },
    { id: "old_admin", tenantId: "T", identityId: "i2", email: "gone@x.test", name: "Gone Admin", role: "ADMIN", isActive: false, createdAt: new Date(1) },
    { id: "admin1", tenantId: "T", identityId: "i3", email: "omer@x.test", name: "Omer", role: "ADMIN", isActive: true, createdAt: new Date(2) },
  ];
});

describe("GET /api/auth/me setupAdmin", () => {
  it("★ while setting up: the first ACTIVE admin, name only", async () => {
    for (const status of ["PENDING_ONBOARDING", "PENDING_ADMIN_SETUP"]) {
      DB.status = status;
      const r = await request(app).get("/api/auth/me");
      expect(r.status).toBe(200);
      expect(r.body.setupAdmin).toEqual({ name: "Omer" });
    }
  });

  it("★ never once the workspace is ACTIVE (or any other state)", async () => {
    for (const status of ["ACTIVE", "SUSPENDED"]) {
      DB.status = status;
      expect((await request(app).get("/api/auth/me")).body).not.toHaveProperty("setupAdmin");
    }
  });

  it("no active admin with a name → no field", async () => {
    DB.users = DB.users.filter((u) => u.id !== "admin1");
    expect((await request(app).get("/api/auth/me")).body).not.toHaveProperty("setupAdmin");
  });
});
