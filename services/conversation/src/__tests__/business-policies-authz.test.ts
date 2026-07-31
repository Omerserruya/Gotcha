/**
 * Business Rules API authorization: permission-FIRST (settings:business-
 * policies:*) through the active membership, with the transitional admin-role
 * fallback, and hard tenant scoping - every query runs against the
 * membership-validated tenant, never a client-supplied id.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const state = vi.hoisted(() => ({
  // simulated principal for the "authenticated" caller
  user: { userId: "u1", role: "AGENT" as string },
  tenantId: "tenant_a",
  grantedPermissions: new Set<string>(),
  prisma: {
    businessActionPolicy: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null), create: vi.fn(async (a: any) => ({ id: "p1", ...a.data })) },
    policyDecision: { create: vi.fn(async () => ({})) },
  },
}));

vi.mock("@chatcenter/shared", () => ({
  // Version pins now live in shared modules, so exhaustive mocks of this
  // barrel must supply them. Returning the real defaults keeps any URL the
  // code builds meaningful instead of "undefined/...".
  shopifyApiVersion: () => "2026-07",
  checkShopifyResponseVersion: () => ({ ok: true, served: "2026-07" }),
  metaGraphBaseUrl: (legacy?: string) => legacy || "https://graph.facebook.com/v24.0",
  stripeVersionHeader: () => ({ "Stripe-Version": "2026-02-25.clover" }),
  prisma: state.prisma,
  authenticate: (req: any, _res: any, next: any) => { req.user = state.user; next(); },
  resolveTenant: (req: any, _res: any, next: any) => { req.tenantId = state.tenantId; next(); },
  requireActiveTenant: () => (_req: any, _res: any, next: any) => next(),
  // Mirrors the real gate's contract: permission first, then role fallback.
  requirePermissionOrRole: (permission: string, ...roles: string[]) =>
    (req: any, res: any, next: any) => {
      if (state.grantedPermissions.has(permission)) return next();
      if (roles.includes(req.user?.role)) return next();
      return res.status(403).json({ error: "Permission denied", code: "PERMISSION_DENIED" });
    },
  evaluateBusinessPolicy: vi.fn(async (opts: any) => ({
    decision: "ALLOWED", policyId: null, policyVersion: null,
    matchedRules: [], reasonCodes: [], _tenantSeen: opts.tenantId,
  })),
}));

import businessPolicyRoutes from "../routes/business-policies";

const app = express();
app.use(express.json());
app.use("/api/business-policies", businessPolicyRoutes);

beforeEach(() => {
  vi.clearAllMocks();
  state.user = { userId: "u1", role: "AGENT" };
  state.tenantId = "tenant_a";
  state.grantedPermissions = new Set();
});

describe("authorization", () => {
  it("denies a member with neither the permission nor an admin role", async () => {
    for (const [method, path] of [["get", "/"], ["put", "/COMPENSATION"], ["post", "/COMPENSATION/preview"]] as const) {
      const res = await (request(app) as any)[method](`/api/business-policies${path}`).send({});
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("PERMISSION_DENIED");
    }
  });

  it("the PERMISSION alone grants access - no admin role needed (delegable to a finance lead)", async () => {
    state.grantedPermissions = new Set(["settings:business-policies:manage"]);
    const res = await request(app).put("/api/business-policies/COMPENSATION").send({ enabled: true, config: { maxAmount: 20 } });
    expect(res.status).toBe(200);
  });

  it("read and manage are SEPARATE grants - read does not confer manage", async () => {
    state.grantedPermissions = new Set(["settings:business-policies:read"]);
    expect((await request(app).get("/api/business-policies")).status).toBe(200);
    expect((await request(app).put("/api/business-policies/REFUND").send({})).status).toBe(403);
  });

  it("legacy admin-role fallback still works (transitional licensing net)", async () => {
    state.user = { userId: "u1", role: "ADMIN" };
    expect((await request(app).get("/api/business-policies")).status).toBe(200);
    expect((await request(app).put("/api/business-policies/REFUND").send({})).status).toBe(200);
  });
});

describe("tenant isolation", () => {
  it("reads are scoped to the ACTIVE membership tenant", async () => {
    state.user = { userId: "u1", role: "ADMIN" };
    state.tenantId = "tenant_a";
    await request(app).get("/api/business-policies");
    expect((state.prisma.businessActionPolicy.findMany.mock.calls[0] as any[])[0].where.tenantId).toBe("tenant_a");
  });

  it("writes carry the active tenant - a body-supplied tenantId is ignored", async () => {
    state.user = { userId: "u1", role: "ADMIN" };
    state.tenantId = "tenant_a";
    await request(app)
      .put("/api/business-policies/COMPENSATION")
      .send({ enabled: true, tenantId: "tenant_b", config: { maxAmount: 5 } });
    const created = state.prisma.businessActionPolicy.create.mock.calls[0][0].data;
    expect(created.tenantId).toBe("tenant_a");
  });

  it("previews evaluate against the active tenant only", async () => {
    const shared = await import("@chatcenter/shared");
    state.user = { userId: "u1", role: "ADMIN" };
    state.tenantId = "tenant_a";
    await request(app).post("/api/business-policies/REFUND/preview").send({ facts: { requestedAmount: 10 } });
    expect((shared.evaluateBusinessPolicy as any).mock.calls[0][0].tenantId).toBe("tenant_a");
  });
});
