/**
 * The readiness report runs by itself after a hire (A6, Omer 2026-10-13): in
 * the background, stored on the employee, never blocking or failing the hire;
 * the manual route still re-runs it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({
  agent: null as any,
  updates: [] as any[],
  generate: vi.fn(),
  ready: true,
}));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const pass = (_q: any, _s: any, n: any) => n();
  return {
    ...actual,
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "ADMIN" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requireOnboardingOrActiveTenant: () => pass,
    requireRole: () => pass,
    prisma: {
      aIAgent: {
        findFirst: async (a: any) => (H.agent && a.where.id === H.agent.id && a.where.tenantId === "T" ? H.agent : null),
        update: async (a: any) => { H.updates.push(a.data); return {}; },
      },
      tenant: { findUnique: async () => ({ defaultLocale: "he" }) },
    },
  };
});
vi.mock("../services/agent-builder.service", () => ({
  runBuilder: vi.fn(), seedDraftFromGoal: vi.fn(),
  loadDraftSnapshot: vi.fn(async () => ({})),
  draftReadiness: () => (H.ready ? { ready: true, missing: [] } : { ready: false, missing: ["knowledge"] }),
}));
vi.mock("../services/agent-readiness.service", () => ({ generateReadinessReport: H.generate }));
vi.mock("../services/sales-context-generator.service", () => ({ generateSalesContext: vi.fn(async () => null) }));

import router from "../routes/ai-agent-builder";
const app = express();
app.use(express.json());
app.use("/api/ai-agents/builder", router);

const settle = () => new Promise((r) => setTimeout(r, 10));
const REPORT = { score: 72, questions: [] };

beforeEach(() => {
  H.updates = []; H.ready = true;
  H.generate.mockReset().mockResolvedValue(REPORT);
});

describe("after a hire", () => {
  it("★ DRAFT -> ACTIVE runs the report in the background and stores it", async () => {
    H.agent = { id: "maya", status: "DRAFT", salesContext: { a: 1 } };
    const r = await request(app).post("/api/ai-agents/builder/maya/complete").send({});
    expect(r.status).toBe(200);
    expect(r.body.data.readinessQueued).toBe(true);
    await settle();
    expect(H.generate).toHaveBeenCalledWith("T", "maya", "he");
    expect(H.updates).toContainEqual({ readinessReport: REPORT });
    expect(H.updates[0]).toMatchObject({ status: "ACTIVE" });
  });

  it("a failing report never fails the hire", async () => {
    H.agent = { id: "maya", status: "DRAFT", salesContext: { a: 1 } };
    H.generate.mockRejectedValue(new Error("model down"));
    const r = await request(app).post("/api/ai-agents/builder/maya/complete").send({});
    expect(r.status).toBe(200);
    await settle();
    expect(H.updates.some((u) => "readinessReport" in u)).toBe(false);
  });

  it("completing an employee that was already active does not re-run it", async () => {
    H.agent = { id: "maya", status: "ACTIVE", salesContext: { a: 1 } };
    const r = await request(app).post("/api/ai-agents/builder/maya/complete").send({});
    expect(r.body.data.readinessQueued).toBe(false);
    await settle();
    expect(H.generate).not.toHaveBeenCalled();
  });

  it("a draft that is not ready is not hired, and nothing runs", async () => {
    H.agent = { id: "maya", status: "DRAFT", salesContext: { a: 1 } };
    H.ready = false;
    expect((await request(app).post("/api/ai-agents/builder/maya/complete").send({})).status).toBe(422);
    await settle();
    expect(H.generate).not.toHaveBeenCalled();
  });
});

describe("the manual re-run", () => {
  it("still returns and stores the report", async () => {
    H.agent = { id: "maya", status: "ACTIVE" };
    const r = await request(app).post("/api/ai-agents/builder/maya/readiness-test").send({ locale: "en" });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual(REPORT);
    expect(H.generate).toHaveBeenCalledWith("T", "maya", "en");
    expect(H.updates).toEqual([{ readinessReport: REPORT }]);
  });
});
