/**
 * POST /api/workspace/scan answers at once and GET reads the run (2026-10-14).
 * The scan takes 25-40 seconds and the browser and BFF stop waiting at 20, so
 * the screen said "the scan did not run" while it finished 20 seconds later.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({ start: null as any, run: null as any, startArgs: null as any }));

vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  const pass = (_q: any, _s: any, n: any) => n();
  return {
    ...actual,
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "t1"; n(); },
    requireOnboardingOrActiveTenant: () => pass,
    requirePermission: () => pass,
  };
});
vi.mock("../services/field-provenance.service", () => ({
  readProvenance: async () => ({}),
  fieldSources: () => ({ businessDescription: "scan" }),
  stampProvenance: async () => {},
}));
vi.mock("../services/business-scan.service", () => ({
  startProfileRescan: async (args: any) => { H.startArgs = args; return H.start; },
  readScanRun: async () => H.run,
  acceptScanProposal: async () => ({ ok: true, accepted: [], skipped: [] }),
}));

import router from "../routes/workspace";
const app = express();
app.use(express.json());
app.use("/api", router);

const RUN = { runId: "r1", status: "running", startedAt: "2026-10-14T09:00:00.000Z", finishedAt: null, reason: null, applied: [], offer: [], reach: null };

beforeEach(() => { H.start = null; H.run = null; H.startArgs = null; });

describe("POST /api/workspace/scan", () => {
  it("★ 202 at once with the running run; the caller's token goes to the run", async () => {
    H.start = { started: true, run: RUN };
    const r = await request(app).post("/api/workspace/scan").set("Authorization", "Bearer user-token").send({ locale: "he" });
    expect(r.status).toBe(202);
    expect(r.body.data).toEqual({ status: "running", startedAt: RUN.startedAt, finishedAt: null, reason: null, applied: [], offer: [], reach: null, knowledge: null, unchanged: false });
    expect(H.startArgs).toMatchObject({ tenantId: "t1", authHeader: "Bearer user-token", actorId: "u1", locale: "he", force: false });
    // The run id is internal.
    expect(r.body.data.runId).toBeUndefined();
  });

  it("another run already going: 409 SCAN_IN_PROGRESS with that run", async () => {
    H.start = { started: false, reason: "scan_in_progress", run: RUN };
    const r = await request(app).post("/api/workspace/scan").send({});
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: "SCAN_IN_PROGRESS", data: { status: "running" } });
  });
});

describe("GET /api/workspace/scan", () => {
  it("★ the last run: done with applied and offer, and the field sources", async () => {
    H.run = { ...RUN, status: "done", finishedAt: "2026-10-14T09:00:30.000Z", applied: ["industry"], offer: [{ field: "businessDescription", proposed: "x" }], reach: { pagesRead: 10 } };
    const r = await request(app).get("/api/workspace/scan");
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    expect(r.body.data).toMatchObject({ run: { status: "done", applied: ["industry"], offer: [{ field: "businessDescription" }], reach: { pagesRead: 10 } }, fieldSources: { businessDescription: "scan" } });
  });

  it("failed with its reason; never run is null", async () => {
    H.run = { ...RUN, status: "failed", reason: "timed_out" };
    expect((await request(app).get("/api/workspace/scan")).body.data.run).toMatchObject({ status: "failed", reason: "timed_out" });
    H.run = null;
    expect((await request(app).get("/api/workspace/scan")).body.data.run).toBeNull();
  });
});
