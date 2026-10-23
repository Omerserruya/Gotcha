/**
 * A suspended workspace cannot finish onboarding its way back to ACTIVE
 * (hotfix, 2026-10-23).
 *
 * POST /api/onboarding/complete set ACTIVE for every status except
 * PENDING_PAYMENT, so the admin of a workspace billing had SUSPENDED could
 * send { skipCoreSystem: true } and reopen it with no payment. Now only a
 * workspace being set up gets through; everything else is refused before any
 * read past the tenant, any write, hire, email or nudge.
 *
 * Mocks only: every prisma call after the gate is a spy that must not run.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({ status: "SUSPENDED", touched: [] as string[], emails: 0, nudges: 0 }));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const spy = (name: string) => new Proxy({}, { get: (_t, op: string) => async () => { H.touched.push(`${name}.${op}`); return null; } });
  return {
    ...actual,
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "ADMIN" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requireRole: () => (_q: any, _s: any, n: any) => n(),
    prisma: new Proxy({
      tenant: { findUnique: async () => ({ id: "T", status: H.status, name: "Acme" }), update: async () => { H.touched.push("tenant.update"); } },
    } as any, { get: (t: any, k: string) => (k in t ? t[k] : k === "$transaction" ? async () => { H.touched.push("$transaction"); } : spy(k)) }),
  };
});
vi.mock("../services/notification.service", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  sendActivationConfirmation: async () => { H.emails++; },
}));
vi.mock("../services/nudge-engine.service", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  scheduleOnboardingNudge: async () => { H.nudges++; },
}));

import onboarding from "../routes/onboarding";
const app = express();
app.use(express.json());
app.use("/api/onboarding", onboarding);

beforeEach(() => { H.touched = []; H.emails = 0; H.nudges = 0; });

describe("POST /complete is for a workspace being set up", () => {
  for (const [status, code] of [["SUSPENDED", "TENANT_SUSPENDED"], ["SOMETHING_NEW", "TENANT_NOT_ONBOARDING"]] as const) {
    it(`${status}: 409 ${code} before anything else - even with skipCoreSystem`, async () => {
      H.status = status;
      const r = await request(app).post("/api/onboarding/complete").send({ skipCoreSystem: true });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe(code);
      expect(H.touched).toEqual([]);
      expect(H.emails).toBe(0);
      expect(H.nudges).toBe(0);
    });
  }

  it("ACTIVE: 'Already active', no side effects (unchanged)", async () => {
    H.status = "ACTIVE";
    const r = await request(app).post("/api/onboarding/complete").send({ skipCoreSystem: true });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ status: "ACTIVE", message: "Already active" });
    expect(H.touched).toEqual([]);
  });

  it("a workspace being set up gets past the gate (the next check is the business profile)", async () => {
    H.status = "PENDING_ONBOARDING";
    const r = await request(app).post("/api/onboarding/complete").send({});
    expect(r.status).toBe(400);
    expect(H.touched).toContain("businessProfile.findUnique");
  });

  it("the ACTIVE write itself is limited to the two setup statuses", () => {
    const src = readFileSync(join(__dirname, "../routes/onboarding.ts"), "utf8");
    expect(src).toContain('const opening = tenant.status === "PENDING_ADMIN_SETUP" || tenant.status === "PENDING_ONBOARDING";');
    expect(src).toContain("...(awaitingPayment || !opening");
  });
});
