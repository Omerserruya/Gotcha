/**
 * Onboarding's channels step reads the widget's install code before the
 * workspace is ACTIVE (omer-onb-1, 2026-10-24: a 403 there showed "we couldn't
 * read the chat code"). Only that read is onboarding-reachable; the settings
 * and every write still need the paid product. The status gates run the REAL
 * matrix over a test status, so this pins the wiring and the matrix together.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({ status: "PENDING_ADMIN_SETUP" as string }));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const gate = (scope: string) => () => (_req: any, res: any, next: any) => {
    const d = actual.evaluateTenantAccess(H.status, scope);
    return d.allow ? next() : res.status(d.httpStatus).json({ code: d.code });
  };
  return {
    ...actual,
    authenticate: (_req: any, _res: any, next: any) => next(),
    resolveTenant: (req: any, _res: any, next: any) => { req.tenantId = "T"; next(); },
    requirePermission: () => (_req: any, _res: any, next: any) => next(),
    requireRole: () => (_req: any, _res: any, next: any) => next(),
    requireActiveTenant: gate("FULL_APPLICATION"),
    requireOnboardingOrActiveTenant: gate("ONBOARDING"),
  };
});
vi.mock("../services/website-widget.service", () => ({
  installOf: async () => ({ code: "<script>", live: false }),
  getWidget: async () => ({}),
  putWidget: async () => ({}),
  connectedWooStore: async () => null,
  WidgetInputError: class extends Error {},
}));

import router from "../routes/website-widget";

const app = () => { const a = express(); a.use(express.json()); a.use("/api/website-widget", router); return a; };

beforeEach(() => { H.status = "PENDING_ADMIN_SETUP"; });

describe("the widget's install code during onboarding", () => {
  it.each(["PENDING_ADMIN_SETUP", "PENDING_ONBOARDING", "PENDING_PAYMENT", "ACTIVE"])("%s: GET /install is readable", async (s) => {
    H.status = s;
    const r = await request(app()).get("/api/website-widget/install");
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ code: "<script>", live: false });
  });

  it("SUSPENDED: GET /install stays closed", async () => {
    H.status = "SUSPENDED";
    expect((await request(app()).get("/api/website-widget/install")).status).toBe(403);
  });

  it.each(["PENDING_ADMIN_SETUP", "PENDING_ONBOARDING"])("%s: the settings and writes still need the paid product", async (s) => {
    H.status = s;
    expect((await request(app()).get("/api/website-widget")).status).toBe(403);
    expect((await request(app()).put("/api/website-widget").send({})).status).toBe(403);
    expect((await request(app()).put("/api/website-widget/assignment").send({})).status).toBe(403);
  });
});
