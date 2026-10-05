/**
 * The new analytics reads are reachable THROUGH THE ROUTER, not just as
 * service functions.
 *
 * The per-day series was first registered as GET /daily - a path that already
 * served getDailyVolume to the old app, earlier in the same router. Express
 * answers the first registration, so the new handler never ran, while its
 * service-level tests passed. These requests go through the real router, and a
 * second test fails the moment any path is registered twice.
 */
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import fs from "fs";
import path from "path";

vi.mock("@chatcenter/shared", () => ({
  authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "ADMIN" }; n(); },
  resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
  requireRole: () => (_q: any, _s: any, n: any) => n(),
  requirePermission: () => (_q: any, _s: any, n: any) => n(),
}));
vi.mock("../services/analytics.service", () => ({
  getDailyVolume: async () => [{ date: "2026-10-01", total: 1, inbound: 1, outbound: 0, closed: 0 }],
  getDailySeries: async () => ({ days: 7, from: "f", to: "t", timezone: "UTC", series: [{ date: "2026-10-01", gotcha: 1, team: 0, alone: 1, passedOver: 0 }] }),
  getTeamReport: async () => ({ days: 7, members: [], cards: { handledByPeople: 0 } }),
  getTimeSaved: async () => ({ secondsSaved: 0, basis: { conversationsHandled: 0 } }),
}));

import router from "../routes/analytics";

const app = express();
app.use("/api/analytics", router);

describe("reachable through the router", () => {
  it("★ /daily-series answers with the series shape", async () => {
    const r = await request(app).get("/api/analytics/daily-series?days=7");
    expect(r.status).toBe(200);
    expect(r.body.data.series[0]).toEqual({ date: "2026-10-01", gotcha: 1, team: 0, alone: 1, passedOver: 0 });
  });

  it("the old /daily still answers the old shape (the old app reads it)", async () => {
    const r = await request(app).get("/api/analytics/daily");
    expect(r.body.data[0]).toHaveProperty("total");
  });

  it("/team and /time-saved answer their own shapes", async () => {
    expect((await request(app).get("/api/analytics/team")).body.data).toHaveProperty("members");
    expect((await request(app).get("/api/analytics/time-saved")).body.data).toHaveProperty("secondsSaved");
  });

  it("★ no GET path is registered twice in the analytics router", () => {
    const src = fs.readFileSync(path.join(__dirname, "../routes/analytics.ts"), "utf8");
    const paths = [...src.matchAll(/router\.get\(\s*"([^"]+)"/g)].map((m) => m[1]);
    const dupes = paths.filter((p, i) => paths.indexOf(p) !== i);
    expect(dupes).toEqual([]);
  });
});
