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
  admin: { id: "u1" } as any,
  profile: null as any,
  profileCreates: [] as any[],
  discovery: { status: "COMPLETE", business: { name: "Acme Shoes", summary: "Shoes", industry: "Fashion" }, websiteDomain: "acme.example" } as any,
  agent: null as any,
  emails: [] as string[],
  nudges: [] as any[],
  billing: [] as any[],
  billingStatus: 200,
}));
vi.mock("../services/notification.service", () => ({
  sendActivationConfirmation: async (t: string) => { H.emails.push(t); },
  sendOnboardingInvite: async () => {}, sendTeammateInvite: async () => {}, sendIntegrationRequestEmail: async () => {},
}));
vi.mock("../services/nudge-engine.service", () => ({
  scheduleOnboardingNudge: async (t: string, w: string) => { H.nudges.push([t, w]); },
}));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const db: any = {
    tenant: {
      findUnique: async () => ({ status: H.status, name: "Acme" }),
      update: ({ data }: any) => ({ op: "tenant.update", data }),
      updateMany: ({ where, data }: any) => ({ op: "tenant.updateMany", where, data }),
    },
    tenantOnboarding: { upsert: ({ update }: any) => ({ op: "onboarding.upsert", update }) },
    user: { findFirst: async () => H.admin },
    businessProfile: {
      findUnique: async () => H.profile,
      create: async ({ data }: any) => { H.profileCreates.push(data); H.profile = { id: "bp1", ...data }; return H.profile; },
    },
    businessDiscovery: { findUnique: async () => H.discovery },
    aIAgent: { findFirst: async ({ where }: any) => (H.agent && H.agent.id === where.id ? H.agent : null) },
    $transaction: async (ops: any[]) => {
      const out: any[] = [];
      for (const o of ops) {
        if (o.op === "tenant.update") { H.tenantUpdates.push(o.data); H.status = o.data.status; out.push({}); }
        if (o.op === "tenant.updateMany") {
          const hit = o.where.status.in.includes(H.status);
          if (hit) { H.tenantUpdates.push(o.data); H.status = o.data.status; }
          out.push({ count: hit ? 1 : 0 });
        }
        if (o.op === "onboarding.upsert") { H.onboarding.push(o.update); out.push({}); }
      }
      return out;
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

vi.stubGlobal("fetch", async (url: string, init: any) => {
  H.billing.push({ url, body: JSON.parse(init.body) });
  return new Response(JSON.stringify({ entityId: "be1" }), { status: H.billingStatus });
});

import onboarding from "../routes/onboarding";
const app = express();
app.use(express.json());
app.use((req: any, _r, n) => { req.tenantId = "T"; req.userId = "u1"; n(); });
app.use("/api/onboarding", onboarding);

beforeEach(() => {
  H.status = "PENDING_ONBOARDING"; H.tenantUpdates = []; H.onboarding = []; H.settings = new Map(); H.aiCalls = [];
  H.admin = { id: "u1" }; H.profile = null; H.profileCreates = []; H.agent = null;
  H.discovery = { status: "COMPLETE", business: { name: "Acme Shoes", summary: "Shoes", industry: "Fashion" }, websiteDomain: "acme.example" };
  H.emails = []; H.nudges = []; H.billing = []; H.billingStatus = 200;
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

describe("go-live does what /complete does after the flip - once", () => {
  it("the press that opens the workspace: billing entity, activation email, nudge; reported in activation", async () => {
    const r = await goLive();
    await new Promise((x) => setImmediate(x));
    expect(r.body.data.activation).toEqual({ opened: true, billingEntity: "provisioned" });
    expect(H.billing).toEqual([{ url: expect.stringMatching(/\/api\/internal\/billing\/ensure-entity$/), body: { tenantId: "T" } }]);
    expect(H.emails).toEqual(["T"]);
    expect(H.nudges).toEqual([["T", "1d"]]);
  });

  it("a second press updates the employee and sends NOTHING", async () => {
    await goLive();
    H.billing = []; H.emails = []; H.nudges = [];
    const r = await goLive();
    await new Promise((x) => setImmediate(x));
    expect(r.status).toBe(200);
    expect(H.aiCalls).toHaveLength(2);
    expect(r.body.data.activation).toEqual({ opened: false, billingEntity: null });
    expect([H.billing, H.emails, H.nudges]).toEqual([[], [], []]);
  });

  it("billing down: the workspace still opens; billingEntity 'failed'", async () => {
    H.billingStatus = 503;
    const r = await goLive();
    expect(r.status).toBe(200);
    expect(H.status).toBe("ACTIVE");
    expect(r.body.data.activation).toEqual({ opened: true, billingEntity: "failed" });
  });

  it("no business profile: made from the scan; an existing one is never touched", async () => {
    await goLive();
    expect(H.profileCreates).toEqual([expect.objectContaining({
      tenantId: "T", organizationName: "Acme Shoes", businessDescription: "Shoes", industry: "Fashion", websiteDomain: "acme.example",
      businessPriority: "FAST_RESPONSE",
    })]);
    H.profileCreates = [];
    await goLive();
    expect(H.profileCreates).toEqual([]);
  });

  it("scan not finished: no profile is made (the AI refuses NOT_LEARNED)", async () => {
    H.discovery = { ...H.discovery, status: "RUNNING" };
    H.ai = { status: 409, body: { code: "NOT_LEARNED" } };
    await goLive();
    expect(H.profileCreates).toEqual([]);
  });

  it("no active admin: 400 NO_ACTIVE_ADMIN before anything happens", async () => {
    H.admin = null;
    const r = await goLive();
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("NO_ACTIVE_ADMIN");
    expect([H.aiCalls, H.tenantUpdates, H.profileCreates, H.emails]).toEqual([[], [], [], []]);
  });
});

describe("the setup step", () => {
  it("PATCH saves a known step; GET reads it; an unknown step is a 400", async () => {
    expect((await request(app).get("/api/onboarding/step")).body.data).toEqual({ step: null, employee: null });
    expect((await request(app).patch("/api/onboarding/step").send({ step: "channels" })).status).toBe(200);
    expect((await request(app).get("/api/onboarding/step")).body.data).toEqual({ step: "channels", employee: null });
    expect((await request(app).patch("/api/onboarding/step").send({ step: "nowhere" })).status).toBe(400);
  });

  it("after go-live, the step names the live employee; a deleted one reads null", async () => {
    H.settings.set("onboarding:employeeId", "ag1");
    H.agent = { id: "ag1", name: "Dana", status: "ACTIVE" };
    expect((await request(app).get("/api/onboarding/step")).body.data.employee).toEqual({ id: "ag1", name: "Dana", status: "ACTIVE" });
    H.agent = null;
    expect((await request(app).get("/api/onboarding/step")).body.data.employee).toBeNull();
  });
});

describe("the file upload door", () => {
  it("not multipart: FILE_REQUIRED; over 5MB by its length: FILE_TOO_LARGE; the AI is never called", async () => {
    const plain = await request(app).post("/api/onboarding/learned/upload").send({ text: "x" });
    expect(plain.status).toBe(400);
    expect(plain.body.code).toBe("FILE_REQUIRED");
    const big = await request(app).post("/api/onboarding/learned/upload")
      .attach("file", Buffer.alloc(5 * 1024 * 1024 + 70 * 1024, 97), { filename: "big.txt", contentType: "text/plain" });
    expect(big.status).toBe(413);
    expect(big.body.code).toBe("FILE_TOO_LARGE");
    expect(H.aiCalls).toEqual([]);
  });
});
