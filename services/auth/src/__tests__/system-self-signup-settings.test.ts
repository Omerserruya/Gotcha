/**
 * The console's self sign-up settings: GET/PUT /api/system/self-signup
 * (2026-11-22).
 *
 * The rules themselves (bounds, strict reading) are pinned in
 * packages/shared/src/__tests__/self-signup.test.ts. Here: the door is the
 * system admin's only, a refused save writes nothing, a saved change leaves
 * one audit line with before and after, and the answer always carries the
 * deployment's switch and the bounds.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({
  user: { userId: "sa1", role: "SYSTEM_ADMIN", tenantId: "t_system" } as any,
  stored: null as any,
  system: "t_system" as string | null,
  writes: [] as any[],
  audits: [] as any[],
  readFails: false,
}));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    authenticate: (req: any, res: any, next: any) => {
      if (!H.user) { res.status(401).json({ error: "Not authenticated" }); return; }
      req.user = H.user; next();
    },
    crossTenantMiddleware: (_q: any, _s: any, n: any) => n(),
    systemTenantId: async () => H.system,
    readSelfSignupSettings: async () => {
      if (H.readFails) throw new Error("db down");
      return H.stored ?? { ...actual.SELF_SIGNUP_DEFAULTS };
    },
    writeSelfSignupSettings: async (value: any, updatedBy?: string) => {
      if (!H.system) return false;
      H.writes.push({ value, updatedBy });
      H.stored = value;
      return true;
    },
    writeAudit: async (a: any) => { H.audits.push(a); },
  };
});

import router from "../routes/system-self-signup";

const app = express();
app.use(express.json());
app.use("/api/system", router);

const BOUNDS = {
  trialDays: { min: 1, max: 60 },
  cardRequiredAfterDays: { min: 1, max: 60 },
  trialCredits: { min: 500, max: 20000 },
};
const GOOD = { enabled: true, trialDays: 21, cardRequiredAfterDays: 7, trialCredits: 2000 };
const ENV = process.env.SELF_SIGNUP;

beforeEach(() => {
  H.user = { userId: "sa1", role: "SYSTEM_ADMIN", tenantId: "t_system" };
  H.stored = null; H.system = "t_system"; H.writes = []; H.audits = []; H.readFails = false;
  delete process.env.SELF_SIGNUP;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  if (ENV === undefined) delete process.env.SELF_SIGNUP; else process.env.SELF_SIGNUP = ENV;
});

describe("GET /api/system/self-signup", () => {
  it("before anyone saved: closed, the defaults, the bounds, and the deployment's switch", async () => {
    const r = await request(app).get("/api/system/self-signup");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ enabled: false, trialDays: 14, cardRequiredAfterDays: 14, trialCredits: 5000, envEnabled: false, bounds: BOUNDS });
  });

  it("shows what is saved, and the deployment's switch as it is now", async () => {
    H.stored = GOOD;
    process.env.SELF_SIGNUP = "on";
    const r = await request(app).get("/api/system/self-signup");
    expect(r.body).toEqual({ ...GOOD, envEnabled: true, bounds: BOUNDS });
  });

  it("a read that fails is a 500, never the defaults dressed as the truth", async () => {
    H.readFails = true;
    const r = await request(app).get("/api/system/self-signup");
    expect(r.status).toBe(500);
    expect(r.body.enabled).toBeUndefined();
  });
});

describe("PUT /api/system/self-signup", () => {
  it("saves all four and answers the same shape as the read", async () => {
    const r = await request(app).put("/api/system/self-signup").send(GOOD);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ...GOOD, envEnabled: false, bounds: BOUNDS });
    expect(H.writes).toEqual([{ value: GOOD, updatedBy: "sa1" }]);
  });

  it("one audit line on the System organization, with before and after and who", async () => {
    await request(app).put("/api/system/self-signup").send(GOOD);
    expect(H.audits).toEqual([{
      tenantId: "t_system", actorType: "user", actorId: "sa1",
      action: "platform.self_signup_settings_changed",
      targetType: "platform_setting", targetId: "selfSignup",
      metadata: { before: { enabled: false, trialDays: 14, cardRequiredAfterDays: 14, trialCredits: 5000 }, after: GOOD },
    }]);
  });

  it("the deployment's switch cannot be set from the console", async () => {
    const r = await request(app).put("/api/system/self-signup").send({ ...GOOD, envEnabled: true });
    expect(r.status).toBe(200);
    expect(r.body.envEnabled).toBe(false);
    expect(H.writes[0].value).toEqual(GOOD);
  });

  it.each([
    ["credits above the top", { ...GOOD, trialCredits: 20001 }, { trialCredits: "out_of_range" }],
    ["zero days", { ...GOOD, trialDays: 0 }, { trialDays: "out_of_range" }],
    ["days as text", { ...GOOD, cardRequiredAfterDays: "7" }, { cardRequiredAfterDays: "invalid" }],
    ["a missing field", { enabled: true, trialDays: 14, cardRequiredAfterDays: 14 }, { trialCredits: "required" }],
    ["enabled as text", { ...GOOD, enabled: "true" }, { enabled: "invalid" }],
  ])("%s: 400 naming the field, nothing saved, nothing audited", async (_n, body, fields) => {
    const r = await request(app).put("/api/system/self-signup").send(body);
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "validation", fields });
    expect(H.writes).toEqual([]);
    expect(H.audits).toEqual([]);
  });

  it("no System organization to hold the row: 503, not a false 'saved'", async () => {
    H.system = null;
    const r = await request(app).put("/api/system/self-signup").send(GOOD);
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: "system_organization_missing" });
    expect(H.audits).toEqual([]);
  });
});

describe("the door", () => {
  it.each([["ADMIN"], ["SUPERVISOR"], ["AGENT"]])("a tenant %s is refused on both, and nothing is saved", async (role) => {
    H.user = { userId: "u1", role, tenantId: "t1" };
    expect((await request(app).get("/api/system/self-signup")).status).toBe(403);
    expect((await request(app).put("/api/system/self-signup").send(GOOD)).status).toBe(403);
    expect(H.writes).toEqual([]);
  });

  it("no session: 401 on both", async () => {
    H.user = null;
    expect((await request(app).get("/api/system/self-signup")).status).toBe(401);
    expect((await request(app).put("/api/system/self-signup").send(GOOD)).status).toBe(401);
    expect(H.writes).toEqual([]);
  });

  it("is mounted under /api/system, before the general system routes", () => {
    const index = readFileSync(join(__dirname, "..", "index.ts"), "utf8");
    const mine = index.indexOf('app.use("/api/system", systemSelfSignupRoutes);');
    expect(mine).toBeGreaterThan(-1);
    expect(mine).toBeLessThan(index.indexOf('app.use("/api/system", systemRoutes);'));
  });
});
