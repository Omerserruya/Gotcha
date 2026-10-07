/**
 * ★ GET /api/ai-agents and GET /api/ai-agents/:id no longer return
 * `channels`: it was display-only ("Answers on") and the playbook decides who
 * answers where (GET /:id/reachability reports it per channel).
 */
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const pass = (_q: any, _s: any, n: any) => n();
  const agent = { id: "maya", tenantId: "T", name: "Maya", role: "customer_support", status: "ACTIVE", channels: ["whatsapp"], departmentId: null, knowledgeBases: [], toolPermissions: [], integrationAccess: [] };
  const generic = { findMany: async () => [], findFirst: async () => null, findUnique: async () => null, count: async () => 0, groupBy: async () => [] };
  return {
    ...actual,
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
