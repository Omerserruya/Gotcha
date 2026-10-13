/**
 * The SLA settings are readable by whoever answers conversations (2026-10-12).
 * The inbox's SLA warning is for the agent; the two GETs were ADMIN-only, so an
 * agent got 403 and never saw it. Reading needs conversation:messages:read;
 * writing stays ADMIN (Owner). Values are read under the caller's tenant.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({ user: null as any, reads: [] as string[][], writes: [] as any[], settings: new Map<string, string>() }));

vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  const refuse = (res: any) => res.status(403).json({ error: "forbidden" });
  return {
    ...actual,
    prisma: { department: { findFirst: async (a: any) => (a.where.tenantId === "t1" && a.where.id === "dep1" ? { id: "dep1" } : null) } },
    authenticate: (q: any, _s: any, n: any) => { q.user = H.user; n(); },
    resolveTenant: (q: any, _s: any, n: any) => { q.tenantId = H.user.tenantId; n(); },
    enforceMfaEnrollment: () => (_q: any, _s: any, n: any) => n(),
    requireRole: (role: string) => (q: any, s: any, n: any) => (q.user.role === role ? n() : refuse(s)),
    requirePermissionOrRole: (key: string, role: string) => (q: any, s: any, n: any) =>
      (q.user.role === role || q.user.perms.includes(key) ? n() : refuse(s)),
    readDurableSetting: async (t: string, k: string) => { H.reads.push([t, k]); return H.settings.get(`${t}:${k}`) ?? null; },
    writeDurableSetting: async (t: string, k: string, v: string) => { H.writes.push([t, k, v]); },
  };
});

import agentsRouter from "../routes/agents";
const app = express();
app.use(express.json());
app.use("/api/agents", agentsRouter);

const AGENT = { userId: "u-agent", tenantId: "t1", role: "AGENT", perms: ["conversation:messages:read"] };
const NO_INBOX = { userId: "u-x", tenantId: "t1", role: "AGENT", perms: [] };
const OWNER = { userId: "u-owner", tenantId: "t1", role: "ADMIN", perms: [] };

beforeEach(() => {
  H.reads = []; H.writes = [];
  H.settings = new Map([
    ["t1:sla", JSON.stringify({ enabled: true, slaMinutes: 15, warningThreshold: 80 })],
    ["t1:department:dep1:sla", JSON.stringify({ enabled: true, slaMinutes: 5, warningThreshold: 50 })],
    ["t2:sla", JSON.stringify({ enabled: true, slaMinutes: 999, warningThreshold: 1 })],
  ]);
});

describe("SLA settings: an agent reads, only an Owner writes", () => {
  it("★ an agent who reads conversations gets the workspace and department SLA", async () => {
    H.user = AGENT;
    const ws = await request(app).get("/api/agents/settings/sla");
    expect(ws.status).toBe(200);
    expect(ws.body).toEqual({ enabled: true, slaMinutes: 15, warningThreshold: 80 });
    const dep = await request(app).get("/api/agents/settings/sla/department/dep1");
    expect(dep.status).toBe(200);
    expect(dep.body.slaMinutes).toBe(5);
  });

  it("reads are under the caller's tenant only", async () => {
    H.user = AGENT;
    await request(app).get("/api/agents/settings/sla");
    expect(H.reads).toEqual([["t1", "sla"]]);
  });

  it("someone without conversation access is refused", async () => {
    H.user = NO_INBOX;
    expect((await request(app).get("/api/agents/settings/sla")).status).toBe(403);
    expect((await request(app).get("/api/agents/settings/sla/department/dep1")).status).toBe(403);
    expect(H.reads).toHaveLength(0);
  });

  it("★ an agent cannot write either level", async () => {
    H.user = AGENT;
    const body = { enabled: false, slaMinutes: 60 };
    expect((await request(app).put("/api/agents/settings/sla").send(body)).status).toBe(403);
    expect((await request(app).put("/api/agents/settings/sla/department/dep1").send(body)).status).toBe(403);
    expect(H.writes).toHaveLength(0);
  });

  it("the Owner reads and writes", async () => {
    H.user = OWNER;
    expect((await request(app).get("/api/agents/settings/sla")).status).toBe(200);
    expect((await request(app).put("/api/agents/settings/sla").send({ enabled: true, slaMinutes: 20 })).status).toBe(200);
    expect(H.writes[0].slice(0, 2)).toEqual(["t1", "sla"]);
  });
});

describe("idle automation settings are durable (B8, 2026-10-12)", () => {
  const body = { reminderEnabled: true, reminderDelayMinutes: 90, reminderMessage: "Still there?", autoCloseEnabled: false, autoCloseDelayMinutes: 1440, autoCloseMessage: "" };

  it("PUT writes the durable setting under the tenant, by this person", async () => {
    H.user = OWNER;
    const r = await request(app).put("/api/agents/settings/idle-automation").send(body);
    expect(r.status).toBe(200);
    expect(H.writes).toEqual([["t1", "idleAutomation", JSON.stringify(body)]]);
  });

  it("GET reads it durably, else the defaults", async () => {
    H.user = OWNER;
    expect((await request(app).get("/api/agents/settings/idle-automation")).body.reminderEnabled).toBe(false);
    H.settings.set("t1:idleAutomation", JSON.stringify(body));
    expect((await request(app).get("/api/agents/settings/idle-automation")).body).toEqual(body);
    expect(H.reads).toContainEqual(["t1", "idleAutomation"]);
  });
});
