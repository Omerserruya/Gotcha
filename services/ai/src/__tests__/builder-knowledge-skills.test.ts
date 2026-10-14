/**
 * Hiring step 3 picks knowledge and skills (B5, 2026-10-14): from what the
 * workspace has, or a new one made in place. Knowledge is a whole base.
 *   - /options lists the workspace's skills with whether the draft has them
 *   - POST /:id/skill gives or takes one skill; a new one goes last in "watch"
 *   - POST /:id/skill/new creates a skill (same validation) and gives it
 *   - POST /:id/knowledge/new makes a base this employee reads, attached, with
 *     an optional first document
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({
  skills: [] as any[], agentSkills: [] as any[], runs: [] as any[], kbs: [] as any[], links: [] as any[], docs: [] as any[], n: 0,
  embedded: [] as string[], capacityChecked: 0,
}));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const pass = (_q: any, _s: any, n: any) => n();
  const inList = (v: any, c: any) => (c && typeof c === "object" && "in" in c ? c.in.includes(v) : c && typeof c === "object" && "notIn" in c ? !c.notIn.includes(v) : c && typeof c === "object" && "not" in c ? v !== c.not : c === undefined || c === v);
  return {
    ...actual,
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "ADMIN" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requireOnboardingOrActiveTenant: () => pass,
    requireRole: () => pass,
    requireEntitlement: () => pass,
    requireCapacity: () => (_q: any, _s: any, n: any) => { H.capacityChecked++; n(); },
    prisma: {
      aIAgent: { findFirst: async (a: any) => (a.where.id === "maya" && a.where.tenantId === "T" ? { id: "maya", noSkillPolicy: "answer_from_knowledge" } : null) },
      tenantTool: { findMany: async () => [] },
      agentToolPermission: { findMany: async () => [] },
      knowledgeBase: {
        findMany: async (a: any) => H.kbs.filter((k) => k.tenantId === a.where.tenantId),
        create: async (a: any) => { const k = { id: `kb_${++H.n}`, ...a.data }; H.kbs.push(k); return { id: k.id, name: k.name }; },
        count: async () => H.kbs.length,
      },
      aIAgentKnowledge: {
        findMany: async (a: any) => H.links.filter((l) => l.aiAgentId === a.where.aiAgentId),
        createMany: async (a: any) => { H.links.push(...a.data); return { count: a.data.length }; },
      },
      knowledgeDocument: { create: async (a: any) => { const d = { id: `doc_${++H.n}`, ...a.data }; H.docs.push(d); return { id: d.id }; } },
      businessSkill: {
        findMany: async (a: any) => H.skills.filter((s) => s.tenantId === a.where.tenantId && inList(s.id, a.where.id) && inList(s.status, a.where.status)),
        findFirst: async (a: any) => H.skills.find((s) => s.tenantId === a.where.tenantId && s.id === a.where.id && inList(s.status, a.where.status)) ?? null,
        create: async (a: any) => { const s = { id: `sk_${++H.n}`, ...a.data }; H.skills.push(s); return s; },
        count: async () => 0,
      },
      agentSkill: {
        findMany: async (a: any) => H.agentSkills.filter((r) => r.tenantId === a.where.tenantId && r.aiAgentId === a.where.aiAgentId)
          .sort((x, y) => x.order - y.order).map((r) => ({ ...r, skill: H.skills.find((s) => s.id === r.skillId) })),
        deleteMany: async (a: any) => { H.agentSkills = H.agentSkills.filter((r) => !(r.aiAgentId === a.where.aiAgentId && inList(r.skillId, a.where.skillId))); return {}; },
        upsert: async (a: any) => {
          const k = a.where.aiAgentId_skillId;
          const r = H.agentSkills.find((x) => x.aiAgentId === k.aiAgentId && x.skillId === k.skillId);
          if (r) Object.assign(r, a.update); else H.agentSkills.push({ ...a.create });
          return {};
        },
      },
      skillRun: {
        updateMany: async (a: any) => { H.runs.push(a); return { count: 0 }; },
        groupBy: async () => [],
      },
      $transaction: async (ops: any[]) => Promise.all(ops),
    },
  };
});
vi.mock("../services/agent-builder.service", async (importOriginal) => ({ ...(await importOriginal<any>()), loadDraftSnapshot: vi.fn(async () => ({ ok: true })) }));
vi.mock("../services/agent-readiness.service", () => ({ generateReadinessReport: vi.fn() }));
vi.mock("../services/sales-context-generator.service", () => ({ generateSalesContext: vi.fn(async () => null) }));
vi.mock("../services/embedding.service", () => ({ processDocument: async (id: string) => { H.embedded.push(id); } }));

import router from "../routes/ai-agent-builder";
const app = express();
app.use(express.json());
app.use("/api/ai-agents/builder", router);
const post = (path: string, body: any) => request(app).post(`/api/ai-agents/builder/${path}`).send(body);

beforeEach(() => {
  H.skills = [
    { id: "returns", tenantId: "T", name: "Returns", category: "orders", status: "active" },
    { id: "booking", tenantId: "T", name: "Booking", category: "bookings", status: "draft" },
    { id: "old", tenantId: "T", name: "Old", category: "other", status: "archived" },
    { id: "theirs", tenantId: "OTHER", name: "Theirs", category: "other", status: "active" },
  ];
  H.agentSkills = [{ tenantId: "T", aiAgentId: "maya", skillId: "returns", mode: "on", order: 0 }];
  H.runs = []; H.kbs = [{ id: "kb_co", tenantId: "T", name: "Company", isActive: true }]; H.links = []; H.docs = []; H.n = 0; H.embedded = []; H.capacityChecked = 0;
});

describe("GET /:id/options skills", () => {
  it("★ the workspace's skills, not archived, with whether the draft has them and how", async () => {
    const r = await request(app).get("/api/ai-agents/builder/maya/options");
    expect(r.status).toBe(200);
    expect(r.body.data.skills).toEqual([
      { id: "returns", name: "Returns", category: "orders", status: "active", attached: true, mode: "on" },
      { id: "booking", name: "Booking", category: "bookings", status: "draft", attached: false, mode: null },
    ]);
  });
});

describe("POST /:id/skill", () => {
  it("★ gives one skill: last, in watch; the one it had keeps its place and mode", async () => {
    const r = await post("maya/skill", { skillId: "booking" });
    expect(r.status).toBe(200);
    expect(H.agentSkills.map((s) => [s.skillId, s.mode, s.order])).toEqual([["returns", "on", 0], ["booking", "watch", 1]]);
  });

  it("a mode given is used; giving one it has changes only the mode", async () => {
    await post("maya/skill", { skillId: "booking", mode: "on" });
    await post("maya/skill", { skillId: "returns", mode: "off" });
    expect(H.agentSkills.map((s) => [s.skillId, s.mode, s.order])).toEqual([["returns", "off", 0], ["booking", "on", 1]]);
  });

  it("★ takes one away, ending its open runs", async () => {
    const r = await post("maya/skill", { skillId: "returns", attach: false });
    expect(r.status).toBe(200);
    expect(H.agentSkills).toEqual([]);
    expect(H.runs.at(-1).where).toMatchObject({ aiAgentId: "maya", skillId: { in: ["returns"] }, status: "active" });
  });

  it("an archived or another tenant's skill: 404 SKILL_NOT_FOUND, nothing changed", async () => {
    for (const skillId of ["old", "theirs", "nope"]) {
      const r = await post("maya/skill", { skillId });
      expect(r.status).toBe(404);
      expect(r.body.code).toBe("SKILL_NOT_FOUND");
    }
    expect(H.agentSkills).toHaveLength(1);
  });

  it("bad input: 400; another tenant's draft: 404", async () => {
    expect((await post("maya/skill", {})).body.code).toBe("SKILL_REQUIRED");
    expect((await post("maya/skill", { skillId: "booking", mode: "loud" })).body.code).toBe("INVALID_MODE");
    expect((await post("other/skill", { skillId: "booking" })).status).toBe(404);
    expect(H.agentSkills).toHaveLength(1);
  });
});

describe("POST /:id/skill/new", () => {
  it("★ creates the skill (draft by default) and gives it, last, in watch", async () => {
    const r = await post("maya/skill/new", { name: "  Exchanges ", category: "orders" });
    expect(r.status).toBe(201);
    expect(r.body.data.skill).toMatchObject({ name: "Exchanges", status: "draft", tenantId: "T" });
    expect(H.agentSkills.map((s) => [s.skillId, s.mode])).toEqual([["returns", "on"], [r.body.data.skill.id, "watch"]]);
  });

  it("the same validation as the workspace's create: 422 INVALID_SKILL, nothing given", async () => {
    const r = await post("maya/skill/new", { category: "orders" });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ code: "INVALID_SKILL", field: "name" });
    expect(H.agentSkills).toHaveLength(1);
  });
});

describe("POST /:id/knowledge/new", () => {
  it("★ a new base this employee reads, attached, with its first document learned", async () => {
    const r = await post("maya/knowledge/new", { name: " Shipping ", title: "Delivery times", content: "3-5 days." });
    expect(r.status).toBe(201);
    const kb = H.kbs.find((k) => k.id === r.body.data.knowledgeBase.id);
    expect(kb).toMatchObject({ tenantId: "T", name: "Shipping", scope: "agent", scopeAgentId: "maya" });
    expect(H.links).toEqual([{ aiAgentId: "maya", knowledgeBaseId: kb.id }]);
    expect(H.docs[0]).toMatchObject({ knowledgeBaseId: kb.id, tenantId: "T", title: "Delivery times", content: "3-5 days.", status: "pending" });
    expect(H.embedded).toEqual([r.body.data.documentId]);
    expect(H.capacityChecked).toBe(1);
  });

  it("a base without a first document", async () => {
    const r = await post("maya/knowledge/new", { name: "FAQ" });
    expect(r.status).toBe(201);
    expect(r.body.data.documentId).toBeNull();
    expect(H.docs).toEqual([]);
  });

  it("bad input: 400 with a code, nothing made; another tenant's draft: 404", async () => {
    for (const [body, code] of [
      [{}, "NAME_REQUIRED"],
      [{ name: "n".repeat(121) }, "NAME_TOO_LONG"],
      [{ name: "FAQ", title: "Only a title" }, "DOCUMENT_INCOMPLETE"],
      [{ name: "FAQ", title: "t", content: "c".repeat(50_001) }, "CONTENT_TOO_LONG"],
    ] as const) {
      const r = await post("maya/knowledge/new", body);
      expect(r.status).toBe(400);
      expect(r.body.code).toBe(code);
    }
    expect((await post("other/knowledge/new", { name: "FAQ" })).status).toBe(404);
    expect(H.kbs).toHaveLength(1);
  });
});
