/**
 * Onboarding's channels step lists the voice channels before the workspace is
 * ACTIVE (omer-onb-1, 2026-10-24: a 403 here left the step's channel list
 * unread). Only the list is onboarding-reachable; one channel, its settings and
 * every write still need the paid product. The status gates run the REAL
 * matrix over a test status.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.hoisted(() => {
  process.env.CHANNEL_ENCRYPTION_KEY = "248b2b86ff1b58bb208e102890ba28f2dd0c5c7dbc45fb81ae3d28531044ef37";
});

const H = vi.hoisted(() => ({ status: "PENDING_ADMIN_SETUP" as string }));

vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  const gate = (scope: string) => () => (_req: any, res: any, next: any) => {
    const d = actual.evaluateTenantAccess(H.status, scope);
    return d.allow ? next() : res.status(d.httpStatus).json({ code: d.code });
  };
  return {
    ...actual,
    prisma: {
      tenant: { findUnique: async () => ({ voiceCopilotEnabled: true }) },
      communicationChannel: { findMany: async () => [], findUnique: async () => null },
    },
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "ADMIN" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "tenant_a"; n(); },
    requireActiveTenant: gate("FULL_APPLICATION"),
    requireOnboardingOrActiveTenant: gate("ONBOARDING"),
    requireRole: () => (_q: any, _s: any, n: any) => n(),
    requireEntitlement: () => (_q: any, _s: any, n: any) => n(),
    requireCapacity: () => (_q: any, _s: any, n: any) => n(),
    reportOperationalFailure: () => undefined,
  };
});

import router from "../routes/voice-channels";

const app = express();
app.use(express.json());
app.use("/api/voice-channels", router);

beforeEach(() => { H.status = "PENDING_ADMIN_SETUP"; });

describe("the voice channel list during onboarding", () => {
  it.each(["PENDING_ADMIN_SETUP", "PENDING_ONBOARDING", "ACTIVE"])("%s: GET / is readable", async (s) => {
    H.status = s;
    const r = await request(app).get("/api/voice-channels");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ data: [] });
  });

  it("SUSPENDED: GET / stays closed", async () => {
    H.status = "SUSPENDED";
    expect((await request(app).get("/api/voice-channels")).status).toBe(403);
  });

  it.each(["PENDING_ADMIN_SETUP", "PENDING_ONBOARDING"])("%s: one channel and every write still need the paid product", async (s) => {
    H.status = s;
    expect((await request(app).get("/api/voice-channels/c1")).status).toBe(403);
    expect((await request(app).post("/api/voice-channels").send({})).status).toBe(403);
    expect((await request(app).patch("/api/voice-channels/c1").send({})).status).toBe(403);
    // A trailing-slash or query variant of the list is still the list, nothing more.
    expect((await request(app).get("/api/voice-channels/?x=1")).status).toBe(200);
  });
});
