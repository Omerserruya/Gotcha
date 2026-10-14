/**
 * ★ GET /api/ai-agents and GET /api/ai-agents/:id no longer return
 * `channels`: it was display-only ("Answers on") and the playbook decides who
 * answers where (GET /:id/reachability reports it per channel).
 */
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({ settings: new Map<string, string>(), listWhere: null as any, guards: undefined as unknown }));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const pass = (_q: any, _s: any, n: any) => n();
  const agent = { id: "maya", tenantId: "T", name: "Maya", role: "customer_support", status: "ACTIVE", channels: ["whatsapp"], departmentId: null, knowledgeBases: [], toolPermissions: [], integrationAccess: [], get customGuardrails() { return H.guards; } };
  const generic = { findMany: async () => [], findFirst: async () => null, findUnique: async () => null, count: async () => 0, groupBy: async () => [] };
  return {
    ...actual,
    readDurableSetting: async (t: string, k: string) => H.settings.get(`${t}:${k}`) ?? null,
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "ADMIN" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requireActiveTenant: () => pass,
    requirePermissionOrRole: () => pass,
    requireEntitlement: () => pass,
    requireCapacity: () => pass,
    prisma: new Proxy({}, {
      get: (_t, name: string) => name === "aIAgent"
        ? { ...generic, findMany: async (a: any) => { H.listWhere = a?.where; return [agent]; }, findFirst: async () => agent }
        : generic,
    }),
  };
});

import router from "../routes/ai-agents";

const app = () => { const a = express(); a.use(express.json()); a.use("/api/ai-agents", router); return a; };

describe("★ channels is not returned", () => {
  it("list", async () => {
    const r = await request(app()).get("/api/ai-agents");
    expect(r.status).toBe(200);
    expect(r.body.data[0].id).toBe("maya");
    expect(r.body.data[0]).not.toHaveProperty("channels");
  });

  it("detail", async () => {
    const r = await request(app()).get("/api/ai-agents/maya");
    expect(r.status).toBe(200);
    expect(r.body.data.id).toBe("maya");
    expect(r.body.data).not.toHaveProperty("channels");
  });
});

describe("★ the detail carries the readiness status (H7)", () => {
  it("running, with when it started", async () => {
    const startedAt = new Date().toISOString();
    H.settings.set("T:agent:readiness:maya", JSON.stringify({ runId: "r", status: "running", startedAt, finishedAt: null, error: null }));
    const d = (await request(app()).get("/api/ai-agents/maya")).body.data;
    expect(d).toMatchObject({ readinessStatus: "running", readinessStartedAt: startedAt, readinessFinishedAt: null, readinessError: null });
  });

  it("failed keeps its code; never run is null", async () => {
    H.settings.set("T:agent:readiness:maya", JSON.stringify({ runId: "r", status: "failed", startedAt: "2026-10-13T10:00:00.000Z", finishedAt: "2026-10-13T10:01:00.000Z", error: "no_knowledge" }));
    expect((await request(app()).get("/api/ai-agents/maya")).body.data).toMatchObject({ readinessStatus: "failed", readinessError: "no_knowledge" });
    H.settings.clear();
    expect((await request(app()).get("/api/ai-agents/maya")).body.data).toMatchObject({ readinessStatus: null, readinessStartedAt: null });
  });
});

describe("★ a hire stopped over 7 days ago is not listed (kept, not deleted)", () => {
  it("the list leaves out DRAFTs untouched for 7 days, and only those", async () => {
    const before = Date.now();
    await request(app()).get("/api/ai-agents");
    expect(H.listWhere.tenantId).toBe("T");
    expect(H.listWhere.NOT.status).toBe("DRAFT");
    const cutoff = H.listWhere.NOT.updatedAt.lt.getTime();
    expect(before - cutoff).toBeGreaterThanOrEqual(7 * 24 * 3600_000 - 1000);
    expect(before - cutoff).toBeLessThan(7 * 24 * 3600_000 + 60_000);
  });

  it("?includeStaleDrafts=1 lists them", async () => {
    await request(app()).get("/api/ai-agents?includeStaleDrafts=1");
    expect(H.listWhere).toEqual({ tenantId: "T" });
  });
});

describe("★ the employee's own rules are always a list (B4)", () => {
  it("none stored: [] on the list and the detail", async () => {
    H.guards = null;
    expect((await request(app()).get("/api/ai-agents")).body.data[0].customGuardrails).toEqual([]);
    expect((await request(app()).get("/api/ai-agents/maya")).body.data.customGuardrails).toEqual([]);
  });

  it("a stored list as it is; a legacy string (which the prompt skips) as []", async () => {
    H.guards = ["be brief", "no prices"];
    expect((await request(app()).get("/api/ai-agents/maya")).body.data.customGuardrails).toEqual(["be brief", "no prices"]);
    H.guards = "be brief";
    expect((await request(app()).get("/api/ai-agents/maya")).body.data.customGuardrails).toEqual([]);
  });
});
