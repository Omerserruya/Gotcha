/**
 * POST /api/onboarding/go-live and the setup step (2026-10-23): go-live opens
 * only a workspace still being set up - never one whose payment is pending,
 * never a suspended one - and sends nothing. The AI service is a stub.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({
  status: "PENDING_ONBOARDING" as string,
  tenantUpdates: [] as any[],
  onboarding: [] as any[],
  settings: new Map<string, string>(),
  ai: { status: 200, body: { data: { employee: { id: "ag1", name: "Maya", status: "ACTIVE" }, warnings: [] } } } as any,
  aiCalls: [] as any[],
}));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const db: any = {
    tenant: {
      findUnique: async () => ({ status: H.status }),
      update: ({ data }: any) => ({ op: "tenant.update", data }),
    },
    tenantOnboarding: { upsert: ({ update }: any) => ({ op: "onboarding.upsert", update }) },
    $transaction: async (ops: any[]) => {
      for (const o of ops) {
        if (o.op === "tenant.update") { H.tenantUpdates.push(o.data); H.status = o.data.status; }
        if (o.op === "onboarding.upsert") H.onboarding.push(o.update);
      }
    },
  };
  return {
    ...actual,
    prisma: db,
    readDurableSetting: async (_t: string, k: string) => H.settings.get(k) ?? null,
    writeDurableSetting: async (_t: string, k: string, v: string) => { H.settings.set(k, v); },
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1" }; req.userId = "u1"; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requireRole: () => (_q: any, _s: any, n: any) => n(),
  };
});
vi.mock("../services/onboarding-discover/learn", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  aiInternal: async (_t: string, method: string, path: string, body: any) => {
    H.aiCalls.push({ method, path, body });
    return { ok: H.ai.status < 300, status: H.ai.status, body: H.ai.body };
  },
}));

import onboarding from "../routes/onboarding";
const app = express();
app.use(express.json());
app.use((req: any, _r, n) => { req.tenantId = "T"; req.userId = "u1"; n(); });
app.use("/api/onboarding", onboarding);

beforeEach(() => {
  H.status = "PENDING_ONBOARDING"; H.tenantUpdates = []; H.onboarding = []; H.settings = new Map(); H.aiCalls = [];
  H.ai = { status: 200, body: { data: { employee: { id: "ag1", name: "Maya", status: "ACTIVE" }, warnings: [] } } };
});

const goLive = (body: any = { confirm: true }) => request(app).post("/api/onboarding/go-live").send(body);

describe("go-live gating", () => {
  it("a workspace being set up: the employee goes live, the workspace opens, the step is 'live'", async () => {
    const r = await goLive({ confirm: true, employeeName: "Maya" });
    expect(r.status).toBe(200);
    expect(H.aiCalls).toEqual([{ method: "POST", path: "/api/ai-assist/onboarding-employee", body: { employeeName: "Maya", actor: "u1" } }]);
    expect(H.tenantUpdates).toEqual([{ status: "ACTIVE" }]);
    expect(H.onboarding[0]).toMatchObject({ currentStep: "COMPLETED" });
    expect(H.settings.get("onboarding:step")).toBe("live");
    expect(r.body.data).toMatchObject({ employee: { id: "ag1" }, test: { suggestedOrderQuestion: null } });
  });

  for (const [status, code] of [["PENDING_PAYMENT", "TENANT_AWAITING_PAYMENT"], ["SUSPENDED", "TENANT_SUSPENDED"]] as const) {
    it(`${status}: refused with ${code}; no employee, no status change`, async () => {
      H.status = status;
      const r = await goLive();
      expect(r.status).toBe(409);
      expect(r.body.code).toBe(code);
      expect(H.aiCalls).toEqual([]);
      expect(H.tenantUpdates).toEqual([]);
    });
  }

  it("an ACTIVE workspace stays as it is (no status write), the employee is still updated", async () => {
    H.status = "ACTIVE";
    const r = await goLive();
    expect(r.status).toBe(200);
    expect(H.tenantUpdates).toEqual([]);
  });

  it("nothing learned yet: the AI's 409 is passed on, and nothing opens", async () => {
    H.ai = { status: 409, body: { code: "NOT_LEARNED" } };
    const r = await goLive();
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("NOT_LEARNED");
    expect(H.tenantUpdates).toEqual([]);
  });

  it("the AI failing: 502, nothing opens", async () => {
    H.ai = { status: 500, body: {} };
    expect((await goLive()).status).toBe(502);
    expect(H.tenantUpdates).toEqual([]);
  });

  it("confirm is required", async () => {
    expect((await goLive({})).status).toBe(400);
    expect(H.aiCalls).toEqual([]);
  });
});

describe("the setup step", () => {
  it("PATCH saves a known step; GET reads it; an unknown step is a 400", async () => {
    expect((await request(app).get("/api/onboarding/step")).body.data).toEqual({ step: null });
    expect((await request(app).patch("/api/onboarding/step").send({ step: "channels" })).status).toBe(200);
    expect((await request(app).get("/api/onboarding/step")).body.data).toEqual({ step: "channels" });
    expect((await request(app).patch("/api/onboarding/step").send({ step: "nowhere" })).status).toBe(400);
  });
});
