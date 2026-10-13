/**
 * ★ GET /api/ai-agents and GET /api/ai-agents/:id no longer return
 * `channels`: it was display-only ("Answers on") and the playbook decides who
 * answers where (GET /:id/reachability reports it per channel).
 */
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({ settings: new Map<string, string>() }));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const pass = (_q: any, _s: any, n: any) => n();
  const agent = { id: "maya", tenantId: "T", name: "Maya", role: "customer_support", status: "ACTIVE", channels: ["whatsapp"], departmentId: null, knowledgeBases: [], toolPermissions: [], integrationAccess: [] };
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
        ? { ...generic, findMany: async () => [agent], findFirst: async () => agent }
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
