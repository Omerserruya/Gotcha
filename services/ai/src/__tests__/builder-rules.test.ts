/**
 * The hire's rules go through the same list and limits as PUT /:id/rules (B4):
 * the wizard's refinements step and the builder's set_rules tool both refuse
 * over a limit instead of cutting, and an empty list clears.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { Prisma } from "@prisma/client";

const H = vi.hoisted(() => ({ updates: [] as any[] }));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "ADMIN" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requireOnboardingOrActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    requireRole: () => (_q: any, _s: any, n: any) => n(),
    prisma: {
      aIAgent: {
        findFirst: async (a: any) => (a.where.id === "maya" && (a.where.tenantId === undefined || a.where.tenantId === "T") ? { id: "maya", persona: {} } : null),
        update: async (a: any) => { H.updates.push(a); return {}; },
      },
    },
  };
});
vi.mock("../services/agent-builder.service", async (importOriginal) => ({ ...(await importOriginal<any>()), loadDraftSnapshot: vi.fn(async () => ({})) }));
vi.mock("../services/agent-readiness.service", () => ({ generateReadinessReport: vi.fn() }));
vi.mock("../services/sales-context-generator.service", () => ({ generateSalesContext: vi.fn(async () => null) }));

import router from "../routes/ai-agent-builder";
import { dispatchBuilderTool } from "../services/agent-builder.service";
const app = express();
app.use(express.json());
app.use("/api/ai-agents/builder", router);
const refine = (body: any) => request(app).post("/api/ai-agents/builder/maya/refinements").send(body);

beforeEach(() => { H.updates = []; });

describe("POST /builder/:id/refinements customGuardrails", () => {
  it("★ a list is trimmed and repeats dropped", async () => {
    const r = await refine({ customGuardrails: [" be brief ", "be brief", "", "no prices"] });
    expect(r.status).toBe(200);
    expect(H.updates.at(-1).data.customGuardrails).toEqual(["be brief", "no prices"]);
  });

  it("★ a rule over 280 characters is refused, never cut; nothing stored", async () => {
    const r = await refine({ customGuardrails: ["x".repeat(281)] });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: "GUARDRAILS_INVALID", reason: "too_long", max: 280 });
    expect(H.updates).toEqual([]);
  });

  it("21 rules are refused; a string is refused", async () => {
    expect((await refine({ customGuardrails: Array.from({ length: 21 }, (_, i) => `r${i}`) })).body).toMatchObject({ reason: "too_many", max: 20 });
    expect((await refine({ customGuardrails: "be brief" })).body).toMatchObject({ reason: "not_a_list" });
    expect(H.updates).toEqual([]);
  });

  it("[] and null clear them", async () => {
    await refine({ customGuardrails: [] });
    expect(H.updates.at(-1).data.customGuardrails).toBe(Prisma.DbNull);
    await refine({ customGuardrails: null });
    expect(H.updates.at(-1).data.customGuardrails).toBe(Prisma.DbNull);
  });
});

describe("the builder's set_rules tool", () => {
  const input: any = { tenantId: "T", agentId: "maya" };

  it("★ stores the normalized list", async () => {
    const r = await dispatchBuilderTool("set_rules", { rules: [" no refunds over 500 ", "no refunds over 500"] }, input);
    expect(r.mutated).toBe(true);
    expect(H.updates.at(-1).data.customGuardrails).toEqual(["no refunds over 500"]);
  });

  it("★ over a limit goes back to the model to shorten; nothing stored", async () => {
    const r = await dispatchBuilderTool("set_rules", { rules: ["y".repeat(300)] }, input);
    expect(r.mutated).toBe(false);
    expect(r.toModel).toMatchObject({ ok: false, max: 280 });
    expect(H.updates).toEqual([]);
  });
});
