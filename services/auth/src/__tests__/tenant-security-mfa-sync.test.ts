/**
 * Option B: a workspace MFA policy change reaches Authentik's
 * gotcha_mfa_required marker at once, from the PATCH that changes it. The
 * sync sat in the GET handler until 2026-11-11 (found on the dev walk), so a
 * change reached Authentik only on the next read of the security page.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({ tenant: { mfaRequiredForAdmins: false, mfaRequiredForAllUsers: false }, synced: [] as string[] }));

vi.mock("@chatcenter/shared", () => ({
  authenticate: (req: any, _res: any, next: any) => { req.user = { userId: "u1", role: "ADMIN", tenantId: "T1" }; next(); },
  resolveTenant: (req: any, _res: any, next: any) => { req.tenantId = "T1"; next(); },
  requirePermissionOrRole: () => (_req: any, _res: any, next: any) => next(),
  writeAudit: vi.fn(async () => undefined),
  AuditAction: { MFA_POLICY_CHANGED: "MFA_POLICY_CHANGED" },
  mfaRequirementFor: () => ({ required: false }),
  getMfaEnrollmentMap: async () => new Map(),
  prisma: {
    tenant: {
      findUnique: async () => ({ ...H.tenant }),
      update: async (a: any) => { Object.assign(H.tenant, a.data); return { ...H.tenant }; },
    },
    user: { findMany: async () => [] },
  },
}));
vi.mock("../services/mfa-required-flag.service", () => ({
  syncMfaRequiredFlagsForTenant: async (tenantId: string) => { H.synced.push(tenantId); },
}));

import router from "../routes/tenant-security";

const app = express();
app.use(express.json());
app.use("/api/tenant/security", router);
const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => { H.tenant = { mfaRequiredForAdmins: false, mfaRequiredForAllUsers: false }; H.synced = []; });

describe("the MFA policy and Authentik's marker", () => {
  it("turning a policy on syncs the workspace's members at once", async () => {
    const r = await request(app).patch("/api/tenant/security").send({ mfaRequiredForAdmins: true });
    expect(r.status).toBe(200);
    await settle();
    expect(H.synced).toEqual(["T1"]);
  });

  it("a PATCH that changes nothing does not sync", async () => {
    await request(app).patch("/api/tenant/security").send({ mfaRequiredForAdmins: false });
    await settle();
    expect(H.synced).toEqual([]);
  });

  it("reading the page does not sync", async () => {
    const r = await request(app).get("/api/tenant/security");
    expect(r.status).toBe(200);
    await settle();
    expect(H.synced).toEqual([]);
  });
});
