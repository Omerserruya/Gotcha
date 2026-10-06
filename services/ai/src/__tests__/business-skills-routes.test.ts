/**
 * /api/business-skills and /api/ai-agents/:id/skills through the REAL routers.
 *
 * The prisma double keeps rows per table, refuses tenant-less queries on the
 * tenant tables, and evaluates the where clauses the service uses (tenantId,
 * id / id in / notIn, status / status not, skillId, aiAgentId, startedAt gte).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({
  viewer: { userId: "admin1", role: "ADMIN", departmentId: undefined as string | undefined },
  tenant: "T",
  db: {
    businessSkill: [] as any[],
    agentSkill: [] as any[],
    skillRun: [] as any[],
    aIAgent: [] as any[],
    conversation: [] as any[],
    agentToolPermission: [] as any[],
  },
  governable: [] as any[],
  seq: 0,
}));

function m(row: any, where: any): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, v]: [string, any]) => {
    if (k === "OR") return (v as any[]).some((w) => m(row, w));
    if (k === "AND") return (v as any[]).every((w) => m(row, w));
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("in" in v) return v.in.includes(row[k]);
      if ("notIn" in v) return !v.notIn.includes(row[k]);
      if ("not" in v) return row[k] !== v.not;
      if ("gte" in v) return row[k] >= v.gte;
      if ("startsWith" in v) return String(row[k] ?? "").startsWith(v.startsWith);
      return true; // relation filters are not modelled
    }
    return (row[k] ?? null) === v;
  });
}
function table(name: keyof typeof H.db, tenantScoped = true) {
  const guard = (w: any) => { if (tenantScoped && !w?.tenantId && !w?.id && !w?.aiAgentId_skillId) throw new Error(`tenant guard: ${name}`); };
  const pick = (r: any, select: any) => {
    if (!select) return { ...r };
    const o: any = {};
    for (const [k, v] of Object.entries(select)) {
      if (k === "aiAgent") o.aiAgent = H.db.aIAgent.find((a) => a.id === r.aiAgentId);
      else if (k === "skill") o.skill = H.db.businessSkill.find((s) => s.id === r.skillId);
      else if (v) o[k] = r[k];
    }
    return o;
  };
  return {
    findMany: async (a: any = {}) => {
      guard(a.where);
      let rows = H.db[name].filter((r) => m(r, a.where));
      if (a.orderBy?.order === "asc") rows = rows.sort((x, y) => x.order - y.order);
      if (Array.isArray(a.orderBy) && a.orderBy[0]?.startedAt === "desc") rows = rows.sort((x, y) => y.startedAt - x.startedAt);
      return rows.slice(0, a.take ?? 1e9).map((r) => pick(r, a.select));
    },
    findFirst: async (a: any = {}) => { guard(a.where); const r = H.db[name].find((x) => m(x, a.where)); return r ? pick(r, a.select) : null; },
    count: async (a: any = {}) => { guard(a.where); return H.db[name].filter((r) => m(r, a.where)).length; },
    create: async (a: any) => {
      const r = { id: `${name}_${++H.seq}`, version: 1, status: "draft", createdAt: new Date(), updatedAt: new Date(), ...a.data };
      H.db[name].push(r);
      return pick(r, a.select);
    },
    update: async (a: any) => {
      const r = H.db[name].find((x) => x.id === a.where.id);
      for (const [k, v] of Object.entries(a.data)) (r as any)[k] = (v as any)?.increment ? (r as any)[k] + (v as any).increment : v;
      return pick(r, a.select);
    },
    updateMany: async (a: any) => {
      guard(a.where);
      const rows = H.db[name].filter((r) => m(r, a.where));
      for (const r of rows) Object.assign(r, a.data);
      return { count: rows.length };
    },
    deleteMany: async (a: any) => {
      guard(a.where);
      const before = H.db[name].length;
      H.db[name] = H.db[name].filter((r) => !m(r, a.where)) as any;
      return { count: before - H.db[name].length };
    },
    upsert: async (a: any) => {
      const k = a.where.aiAgentId_skillId;
      const r = H.db[name].find((x) => x.aiAgentId === k.aiAgentId && x.skillId === k.skillId);
      if (r) { Object.assign(r, a.update); return r; }
      const n = { id: `${name}_${++H.seq}`, ...a.create };
      H.db[name].push(n);
      return n;
    },
    groupBy: async (a: any) => {
      guard(a.where);
      const by = new Map<string, number>();
      for (const r of H.db[name].filter((x) => m(x, a.where))) by.set(r.skillId, (by.get(r.skillId) ?? 0) + 1);
      return [...by].map(([skillId, n]) => ({ skillId, _count: { _all: n } }));
    },
  };
}

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const pass = (_q: any, _s: any, n: any) => n();
  return {
    ...actual,
    authenticate: (req: any, _r: any, n: any) => { req.user = { ...H.viewer }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = H.tenant; n(); },
    requireActiveTenant: () => pass,
    requirePermissionOrRole: () => pass,
    prisma: {
      businessSkill: table("businessSkill"),
      agentSkill: table("agentSkill"),
      skillRun: table("skillRun"),
      aIAgent: table("aIAgent"),
      conversation: table("conversation"),
      agentToolPermission: {
        findMany: async (a: any) => H.db.agentToolPermission.filter((p) => p.tenantId === a.where.tenantId && p.aiAgentId === a.where.aiAgentId && p.isAllowed),
      },
      tenantIntegration: { count: async () => 0 },
      $transaction: async (ops: any[]) => Promise.all(ops),
    },
  };
});
vi.mock("../services/tool-registry", () => ({ getGovernableIntegrationTools: async () => H.governable }));

import businessSkills from "../routes/business-skills";
import agentSkills from "../routes/agent-skills";

const app = express();
app.use(express.json());
app.use("/api/ai-agents", agentSkills);
app.use("/api/business-skills", businessSkills);

const skillBody = (o: any = {}) => ({
  name: "Delivery status",
  situation: "Where is my order?",
  category: "orders",
  whenToUse: "The customer asks where an order is or when it arrives.",
  examples: ["where is my order", "מתי ההזמנה מגיעה"],
  steps: [
    { kind: "find", title: "Find the order", tools: ["shopify.order_lookup"] },
    { kind: "check", title: "Check the shipment", tools: ["shopify.track_shipment"] },
    { kind: "message", title: "Tell the customer", tools: [] },
  ],
  rules: [{ type: "never", text: "Never promise a delivery date the carrier did not give." }],
  requiredInfo: [{ label: "Order number", priority: 1 }],
  ...o,
});

beforeEach(() => {
  H.viewer = { userId: "admin1", role: "ADMIN", departmentId: undefined };
  H.tenant = "T";
  H.seq = 0;
  H.db = {
    businessSkill: [{ id: "other_t", tenantId: "X", name: "Not yours", status: "active", version: 1, steps: [], updatedAt: new Date() }],
    agentSkill: [],
    skillRun: [],
    aIAgent: [
      { id: "maya", tenantId: "T", name: "Maya", noSkillPolicy: "answer_from_knowledge" },
      { id: "x_agent", tenantId: "X", name: "Other" },
    ],
    conversation: [
      { id: "c_sales", tenantId: "T", departmentId: "sales", assignedAgentId: null, customerExternalId: "9725" },
      { id: "c_support", tenantId: "T", departmentId: "support", assignedAgentId: null, customerExternalId: "9726" },
      { id: "c_sandbox", tenantId: "T", departmentId: null, assignedAgentId: null, customerExternalId: "sandbox:maya" },
    ],
    agentToolPermission: [],
  };
  H.governable = [
    { name: "shopify.order_lookup", slug: "order_lookup", integrationSlug: "shopify", integrationStatus: "CONNECTED", isEnabled: true, displayName: "Order lookup", catalogCategory: "ECOMMERCE", riskLevel: "LOW" },
    { name: "shopify.track_shipment", slug: "track_shipment", integrationSlug: "shopify", integrationStatus: "CONNECTED", isEnabled: true, displayName: "Track", catalogCategory: "ECOMMERCE", riskLevel: "LOW" },
  ];
});

describe("the library", () => {
  it("★ create: draft, version 1, step ids generated, required info keyed", async () => {
    const r = await request(app).post("/api/business-skills").send(skillBody());
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ name: "Delivery status", status: "draft", version: 1, category: "orders" });
    expect(r.body.data.steps.map((s: any) => s.id)).toEqual(["s1", "s2", "s3"]);
    expect(r.body.data.requiredInfo).toEqual([{ key: "order_number", label: "Order number", priority: 1 }]);
  });

  it("refuses what it cannot store honestly (422)", async () => {
    expect((await request(app).post("/api/business-skills").send(skillBody({ name: "" }))).status).toBe(422);
    const bad = await request(app).post("/api/business-skills").send(skillBody({ steps: [{ kind: "teleport", title: "x" }] }));
    expect(bad.status).toBe(422);
    expect(bad.body.field).toBe("steps[0].kind");
    // An exclusion may only point at THIS tenant's skill.
    expect((await request(app).post("/api/business-skills").send(skillBody({ exclusions: [{ text: "returns", skillId: "other_t" }] }))).status).toBe(422);
  });

  it("★ PUT bumps the version and keeps step ids; archived cannot be edited", async () => {
    const id = (await request(app).post("/api/business-skills").send(skillBody())).body.data.id;
    const r = await request(app).put(`/api/business-skills/${id}`).send({ status: "active", steps: [{ id: "s2", kind: "check", title: "Check" }] });
    expect(r.body.data).toMatchObject({ version: 2, status: "active" });
    expect(r.body.data.steps[0].id).toBe("s2");
    await request(app).delete(`/api/business-skills/${id}`);
    expect((await request(app).put(`/api/business-skills/${id}`).send({ name: "x" })).status).toBe(422);
  });

  it("★ DELETE archives (never deletes) and ends open runs as abandoned / skill_removed", async () => {
    const id = (await request(app).post("/api/business-skills").send(skillBody())).body.data.id;
    H.db.skillRun.push({ id: "r1", tenantId: "T", skillId: id, aiAgentId: "maya", conversationId: "c_sales", status: "active", mode: "on", startedAt: new Date() });
    const r = await request(app).delete(`/api/business-skills/${id}`);
    expect(r.body.data.status).toBe("archived");
    expect(H.db.businessSkill.some((s) => s.id === id)).toBe(true);
    expect(H.db.skillRun[0]).toMatchObject({ status: "abandoned", stopReason: "skill_removed" });
    expect((await request(app).get("/api/business-skills")).body.data.map((s: any) => s.id)).not.toContain(id);
  });

  it("★ another tenant's skill is 404 everywhere", async () => {
    expect((await request(app).get("/api/business-skills/other_t")).status).toBe(404);
    expect((await request(app).put("/api/business-skills/other_t").send({ name: "x" })).status).toBe(404);
    expect((await request(app).delete("/api/business-skills/other_t")).status).toBe(404);
    expect((await request(app).get("/api/business-skills/other_t/runs")).status).toBe(404);
  });

  it("/stats and /tools are not shadowed by /:id", async () => {
    expect((await request(app).get("/api/business-skills/stats")).body).toHaveProperty("from");
    const tools = (await request(app).get("/api/business-skills/tools")).body.data;
    expect(tools.find((t: any) => t.name === "escalate_to_human")).toMatchObject({ source: "system", connected: true });
    expect(tools.find((t: any) => t.name === "shopify.order_lookup")).toMatchObject({ source: "integration", connected: true });
  });

  it("stats: live runs, watch runs, alone share, asked you, stop reasons, used by", async () => {
    const id = (await request(app).post("/api/business-skills").send(skillBody())).body.data.id;
    H.db.agentSkill.push({ id: "as1", tenantId: "T", aiAgentId: "maya", skillId: id, mode: "on", order: 0 });
    const run = (o: any) => H.db.skillRun.push({ id: `r${++H.seq}`, tenantId: "T", skillId: id, aiAgentId: "maya", conversationId: "c_sales", startedAt: new Date(), trace: [], ...o });
    run({ mode: "on", status: "completed" });
    run({ mode: "on", status: "handed_over", stopReason: "tool_missing" });
    run({ mode: "on", status: "completed", trace: [{ outcome: "approval_requested" }] });
    run({ mode: "watch", status: "completed" });
    // A rehearsal in the employee's test chat is not a real run.
    run({ mode: "on", status: "completed", conversationId: "c_sandbox" });
    const s = (await request(app).get("/api/business-skills/stats")).body.data[0];
    expect(s).toMatchObject({ runs: 3, watchRuns: 1, askedYou: 2, stopReasons: [{ reason: "tool_missing", count: 1 }] });
    expect(s.aloneShare).toBeCloseTo(2 / 3);
    expect(s.usedBy).toEqual([{ aiAgentId: "maya", name: "Maya", mode: "on", order: 0 }]);
  });

  it("★ the run log hides runs in conversations a restricted viewer may not see", async () => {
    const id = (await request(app).post("/api/business-skills").send(skillBody())).body.data.id;
    H.db.skillRun.push(
      { id: "ra", tenantId: "T", skillId: id, aiAgentId: "maya", conversationId: "c_sales", status: "completed", mode: "on", startedAt: new Date(2) },
      { id: "rb", tenantId: "T", skillId: id, aiAgentId: "maya", conversationId: "c_support", status: "completed", mode: "on", startedAt: new Date(1) },
    );
    expect((await request(app).get(`/api/business-skills/${id}/runs`)).body.data.map((r: any) => r.id)).toEqual(["ra", "rb"]);
    H.viewer = { userId: "agent1", role: "AGENT", departmentId: "sales" };
    expect((await request(app).get(`/api/business-skills/${id}/runs`)).body.data.map((r: any) => r.id)).toEqual(["ra"]);
  });
});

describe("an employee's skills", () => {
  it("★ PUT the full list (order, mode); GET returns it ordered with runs", async () => {
    const a = (await request(app).post("/api/business-skills").send(skillBody())).body.data.id;
    const b = (await request(app).post("/api/business-skills").send(skillBody({ name: "Exchange" }))).body.data.id;
    const r = await request(app).put("/api/ai-agents/maya/skills").send([{ skillId: b, mode: "on" }, { skillId: a }]);
    expect(r.status).toBe(200);
    expect(r.body.data.skills.map((s: any) => [s.name, s.mode, s.order])).toEqual([["Exchange", "on", 0], ["Delivery status", "watch", 1]]);
    expect(r.body.data.noSkillPolicy).toBe("answer_from_knowledge");
  });

  it("★ removing or turning off a skill ends the employee's open runs of it", async () => {
    const a = (await request(app).post("/api/business-skills").send(skillBody())).body.data.id;
    await request(app).put("/api/ai-agents/maya/skills").send([{ skillId: a, mode: "on" }]);
    H.db.skillRun.push({ id: "open", tenantId: "T", skillId: a, aiAgentId: "maya", conversationId: "c_sales", status: "active", mode: "on", startedAt: new Date() });
    await request(app).put("/api/ai-agents/maya/skills").send([]);
    expect(H.db.skillRun[0]).toMatchObject({ status: "abandoned", stopReason: "skill_removed" });
    expect(H.db.agentSkill).toHaveLength(0);
  });

  it("refuses another tenant's skill and another tenant's employee", async () => {
    expect((await request(app).put("/api/ai-agents/maya/skills").send([{ skillId: "other_t", mode: "on" }])).status).toBe(422);
    expect((await request(app).get("/api/ai-agents/x_agent/skills")).status).toBe(404);
  });
});

describe("★ the fit check uses the bot's own tool rule", () => {
  it("a tool the employee may not use is where it hands over", async () => {
    const id = (await request(app).post("/api/business-skills").send(skillBody())).body.data.id;
    // Maya may use order_lookup but not track_shipment.
    H.db.agentToolPermission.push({
      tenantId: "T", aiAgentId: "maya", isAllowed: true,
      tenantTool: { catalogTool: { slug: "order_lookup", allowedModes: ["AUTO", "ASSIST"] }, tenantIntegration: { integration: { slug: "shopify" } } },
    });
    const r = (await request(app).post("/api/ai-agents/maya/skills/fit").send({ skillId: id })).body.data;
    expect(r).toMatchObject({ fits: false, handsOverAtStep: "s2", reason: "not_allowed_for_employee" });
    expect(r.steps[0].tools[0]).toEqual({ name: "shopify.order_lookup", allowed: true, connected: true });
    expect(r.steps[1].tools[0]).toMatchObject({ name: "shopify.track_shipment", allowed: false, connected: true });
  });

  it("all tools allowed → fits; an ASSIST-only tool is not allowed (the bot drops it)", async () => {
    const id = (await request(app).post("/api/business-skills").send(skillBody({ steps: [{ kind: "find", title: "Find", tools: ["shopify.order_lookup"] }] }))).body.data.id;
    H.db.agentToolPermission.push({
      tenantId: "T", aiAgentId: "maya", isAllowed: true,
      tenantTool: { catalogTool: { slug: "order_lookup", allowedModes: ["ASSIST"] }, tenantIntegration: { integration: { slug: "shopify" } } },
    });
    expect((await request(app).post("/api/ai-agents/maya/skills/fit").send({ skillId: id })).body.data.fits).toBe(false);
    H.db.agentToolPermission[0].tenantTool.catalogTool.allowedModes = ["AUTO"];
    expect((await request(app).post("/api/ai-agents/maya/skills/fit").send({ skillId: id })).body.data).toMatchObject({ fits: true, handsOverAtStep: null });
  });
});
