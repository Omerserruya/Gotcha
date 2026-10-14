/**
 * /api/automations through the real router, over an in-memory Prisma double
 * that evaluates the where clauses the routes use. Covers:
 *   - ★ a new automation is a draft; isActive in a body is ignored
 *   - ★ ONE gate on every way to go live (activate, a save while live, and
 *     the legacy /api/chatbot-flows POST/PUT that used to bypass it)
 *   - the 09c row (path chips, runs this week, last run, paused by whom)
 *   - the 09e catalogue's availability reasons
 *   - the run log: tenant isolation, department visibility, paging from the
 *     raw page, node stats
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const H = vi.hoisted(() => ({
  tenant: "T",
  viewer: { userId: "admin1", role: "ADMIN", departmentId: undefined as string | undefined },
  db: {} as Record<string, any[]>,
  seq: 0,
  // Permissions the viewer does NOT hold (the gate answers 403 for them).
  lacking: new Set<string>(),
}));

function m(row: any, where: any): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, v]: [string, any]) => {
    if (k === "OR") return (v as any[]).some((w) => m(row, w));
    if (k === "AND") return (v as any[]).every((w) => m(row, w));
    if (k === "run") return m(H.db.automationRun.find((r) => r.id === row.runId) ?? {}, v);
    if (v instanceof Date) return +row[k] === +v;
    if (v && typeof v === "object") {
      if ("in" in v) return v.in.includes(row[k]);
      if ("not" in v) return v.not === null ? row[k] != null : row[k] !== v.not;
      if ("gte" in v) return row[k] >= v.gte;
      return true;
    }
    return (row[k] ?? null) === v;
  });
}
function table(name: string) {
  const rows = () => (H.db[name] ??= []);
  const guard = (w: any) => { if (!w?.tenantId && !w?.id) throw new Error(`tenant guard: ${name}`); };
  const sortDesc = (a: any[], key: string) => [...a].sort((x, y) => +y[key] - +x[key] || String(y.id).localeCompare(String(x.id)));
  return {
    findMany: async (a: any = {}) => {
      guard(a.where);
      let r = rows().filter((x) => m(x, a.where));
      if (a.orderBy?.updatedAt === "desc") r = sortDesc(r, "updatedAt");
      if (Array.isArray(a.orderBy) && a.orderBy[0]?.startedAt === "desc") r = sortDesc(r, "startedAt");
      if (a.cursor) { const i = r.findIndex((x) => x.id === a.cursor.id); r = r.slice(i + (a.skip ?? 0)); }
      return r.slice(0, a.take ?? 1e9).map((x) => ({ ...x }));
    },
    findFirst: async (a: any = {}) => {
      guard(a.where);
      let r = rows().filter((x) => m(x, a.where));
      if (a.orderBy?.startedAt === "desc") r = sortDesc(r, "startedAt");
      const x = r[0];
      if (!x) return null;
      return a.include?.steps ? { ...x, steps: (H.db.automationRunStep ?? []).filter((s) => s.runId === x.id) } : { ...x };
    },
    count: async (a: any = {}) => { guard(a.where); return rows().filter((x) => m(x, a.where)).length; },
    create: async (a: any) => {
      const now = new Date(Date.now() + ++H.seq);
      const x = { id: `${name}_${H.seq}`, createdAt: now, updatedAt: now, isActive: false, pausedAt: null, pausedBy: null, activatedAt: null, activatedBy: null, description: null, ...a.data };
      rows().push(x);
      return { ...x };
    },
    update: async (a: any) => {
      const x = rows().find((r) => r.id === a.where.id);
      Object.assign(x, a.data, { updatedAt: new Date(Date.now() + ++H.seq) });
      return { ...x };
    },
    updateMany: async (a: any) => { guard(a.where); const r = rows().filter((x) => m(x, a.where)); r.forEach((x) => Object.assign(x, a.data)); return { count: r.length }; },
    delete: async (a: any) => { H.db[name] = rows().filter((r) => r.id !== a.where.id); return {}; },
    groupBy: async (a: any) => {
      guard(a.where);
      const by = new Map<string, any>();
      for (const x of rows().filter((r) => m(r, a.where))) {
        const key = a.by.map((k: string) => x[k] ?? "∅").join("|");
        const g = by.get(key) ?? { ...Object.fromEntries(a.by.map((k: string) => [k, x[k] ?? null])), _count: { _all: 0 } };
        g._count._all++;
        by.set(key, g);
      }
      return [...by.values()];
    },
  };
}

vi.mock("@chatcenter/shared", async () => {
  const rule = await import("@chatcenter/shared/src/lib/conversation-visibility-rule");
  const pass = (_q: any, _s: any, n: any) => n();
  return {
    ORDER_STATUSES: ["created", "paid", "fulfilled", "cancelled"],
    visibilityClause: rule.visibilityClause,
    viewerOf: (req: any) => ({ userId: req.user.userId, role: req.user.role, departmentId: req.user.departmentId }),
    authenticate: (req: any, _r: any, n: any) => { req.user = { ...H.viewer }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = H.tenant; n(); },
    requirePermissionOrRole: (perm: string) => (_q: any, res: any, n: any) =>
      H.lacking.has(perm) ? res.status(403).json({ error: "Permission denied", code: "PERMISSION_DENIED", permissions: [perm] }) : n(),
    requireEntitlement: () => pass,
    requireCapacity: () => pass,
    validate: () => pass,
    prisma: {
      chatbotFlow: table("chatbotFlow"),
      automationRun: table("automationRun"),
      automationRunStep: table("automationRunStep"),
      user: table("user"),
      contact: table("contact"),
      conversation: table("conversation"),
      channelAccount: table("channelAccount"),
      communicationChannel: table("communicationChannel"),
    },
  };
});

import automations from "../routes/automations";
import chatbot from "../routes/chatbot";
import { validateAutomation, outputsOf, normalizeTrigger, beforeFirstWait, catalogFor } from "../lib/automation-catalog";

const app = express();
app.use(express.json());
app.use("/api/automations", automations);
app.use("/api/chatbot-flows", chatbot);

/** Call missed → open now? → yes: buttons → wait for reply → per button. */
const goodGraph = () => ({
  nodes: [
    { id: "t", type: "automation_trigger", data: {} },
    { id: "h", type: "opening_hours", data: { label: "Open now?" } },
    { id: "b", type: "send_buttons", data: { text: "Hi {{first_name}}", buttons: [{ id: "call", title: "Call me back" }, { id: "write", title: "Write here" }] } },
    { id: "w", type: "wait_for_reply", data: { timeoutMs: 1_800_000 } },
    { id: "task", type: "create_task", data: { title: "Call back now" } },
    { id: "ai", type: "hand_to_ai", data: { aiAgentId: "maya" } },
    { id: "closed", type: "send_message_text", data: { text: "We're closed right now" } },
  ],
  edges: [
    { id: "e1", source: "t", target: "h" },
    { id: "e2", source: "h", target: "b", sourceHandle: "open" },
    { id: "e3", source: "b", target: "w" },
    { id: "e4", source: "w", target: "task", sourceHandle: "btn:call" },
    { id: "e5", source: "w", target: "ai", sourceHandle: "btn:write" },
    { id: "e6", source: "h", target: "closed", sourceHandle: "closed" },
  ],
});
const msgTrigger = { type: "message_received", config: { channels: ["WHATSAPP"] } };

async function create(body: any = {}) {
  return (await request(app).post("/api/automations").send({ name: "A call is missed", trigger: msgTrigger, ...body })).body.data;
}

beforeEach(() => {
  H.tenant = "T";
  H.viewer = { userId: "admin1", role: "ADMIN", departmentId: undefined };
  H.seq = 0;
  H.lacking = new Set();
  H.db = {
    chatbotFlow: [
      { id: "legacy", tenantId: "T", name: "Sub-flow", triggerType: null, isActive: true, nodes: [], edges: [], updatedAt: new Date(0), createdAt: new Date(0) },
      { id: "other_t", tenantId: "X", name: "Not yours", triggerType: "message_received", triggerConfig: {}, isActive: false, nodes: [], edges: [], updatedAt: new Date(0), createdAt: new Date(0) },
    ],
    user: [{ id: "admin1", tenantId: "T", name: "Omer" }],
    contact: [{ id: "k1", tenantId: "T", displayName: "Dana" }],
    conversation: [
      { id: "c_sales", tenantId: "T", departmentId: "sales", assignedAgentId: null, automationRunId: null },
      { id: "c_support", tenantId: "T", departmentId: "support", assignedAgentId: null, automationRunId: null },
    ],
    channelAccount: [],
    communicationChannel: [],
    automationRun: [],
    automationRunStep: [],
  };
});

describe("★ create and edit", () => {
  it("a new automation is a draft with its trigger step; isActive in the body is ignored", async () => {
    const a = await create({ isActive: true });
    expect(a).toMatchObject({ status: "draft", isActive: false, trigger: msgTrigger });
    expect(a.nodes).toEqual([expect.objectContaining({ type: "automation_trigger" })]);
    expect(a.path).toEqual([{ nodeId: "trigger", type: "automation_trigger", label: "Message received" }]);
  });

  it("refuses a trigger it cannot run honestly (422 with the field)", async () => {
    const r = await request(app).post("/api/automations").send({ name: "x", trigger: { type: "anything" } });
    expect(r.status).toBe(422);
    expect(r.body.field).toBe("trigger.type");
    const t = await request(app).post("/api/automations").send({ name: "x", trigger: { type: "tag_added", config: {} } });
    expect(t.body.field).toBe("trigger.config.tags");
    const s = await request(app).post("/api/automations").send({ name: "x", trigger: { type: "schedule", config: { at: "25:00" } } });
    expect(s.body.field).toBe("trigger.config.at");
  });

  it("the list holds automations only (not the playbook's sub-flows), with the row's chips", async () => {
    const a = await create(goodGraph());
    const list = (await request(app).get("/api/automations")).body.data;
    expect(list.map((x: any) => x.id)).toEqual([a.id]);
    expect(list[0].path.map((p: any) => p.label)).toEqual(["Message received", "Open now?", "Buttons", "Wait for reply", "Create task"]);
    expect(list[0]).not.toHaveProperty("nodes");
  });

  it("another tenant's automation is 404 on every door", async () => {
    for (const [method, path] of [["get", "/api/automations/other_t"], ["put", "/api/automations/other_t"], ["post", "/api/automations/other_t/activate"], ["post", "/api/automations/other_t/pause"], ["delete", "/api/automations/other_t"], ["get", "/api/automations/other_t/runs"]] as const) {
      expect((await (request(app) as any)[method](path).send({ name: "x" })).status).toBe(404);
    }
  });
});

describe("★ one gate to go live", () => {
  it("activate: an incomplete automation is 422 and stays a draft; a complete one goes live with who and when", async () => {
    const a = await create();
    const bad = await request(app).post(`/api/automations/${a.id}/activate`);
    expect(bad.status).toBe(422);
    expect(bad.body.errors.map((e: any) => e.code)).toContain("no_steps");
    expect(H.db.chatbotFlow.find((f) => f.id === a.id).isActive).toBe(false);

    await request(app).put(`/api/automations/${a.id}`).send(goodGraph());
    const ok = await request(app).post(`/api/automations/${a.id}/activate`);
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ status: "live", isActive: true, activatedBy: { id: "admin1", name: "Omer" } });
  });

  it("★ a save while live is validated: errors → 422 and nothing stored", async () => {
    const a = await create(goodGraph());
    await request(app).post(`/api/automations/${a.id}/activate`);
    const g = goodGraph();
    (g.nodes[2].data as any).buttons.push({ id: "c", title: "Three" }, { id: "d", title: "Four" });
    const r = await request(app).put(`/api/automations/${a.id}`).send(g);
    expect(r.status).toBe(422);
    expect(r.body.errors.map((e: any) => e.code)).toContain("too_many_buttons");
    expect(H.db.chatbotFlow.find((f) => f.id === a.id).nodes[2].data.buttons).toHaveLength(2);
    // A draft saves freely.
    await request(app).post(`/api/automations/${a.id}/pause`);
    expect((await request(app).put(`/api/automations/${a.id}`).send(g)).status).toBe(200);
  });

  it("pause records who and when; the row says paused", async () => {
    const a = await create(goodGraph());
    await request(app).post(`/api/automations/${a.id}/activate`);
    const p = (await request(app).post(`/api/automations/${a.id}/pause`)).body.data;
    expect(p).toMatchObject({ status: "paused", isActive: false, pausedBy: { id: "admin1", name: "Omer" } });
    expect(p.pausedAt).toBeTruthy();
    expect((await request(app).get("/api/automations?status=paused")).body.data.map((x: any) => x.id)).toEqual([a.id]);
  });

  it("★ the legacy flows API no longer bypasses validation, and cannot touch an automation", async () => {
    const created = await request(app).post("/api/chatbot-flows").send({ name: "x", nodes: [{ id: "a", type: "send_message_text", data: {} }], edges: [], isActive: true });
    expect(created.status).toBe(422);
    const put = await request(app).put("/api/chatbot-flows/legacy").send({ name: "Sub-flow", nodes: [{ id: "a", type: "send_message_text", data: {} }], edges: [] });
    expect(put.status).toBe(422); // it is live: the new graph must pass
    const a = await create(goodGraph());
    expect((await request(app).put(`/api/chatbot-flows/${a.id}`).send({ name: "x", nodes: [], edges: [], isActive: true })).status).toBe(409);
    expect((await request(app).post(`/api/chatbot-flows/${a.id}/activate`)).status).toBe(409);
  });

  it("delete releases a conversation parked on one of its runs", async () => {
    const a = await create(goodGraph());
    H.db.automationRun.push({ id: "r1", tenantId: "T", flowId: a.id, status: "waiting", startedAt: new Date() });
    Object.assign(H.db.conversation[0], { automationRunId: "r1", chatbotNodeId: "w", chatbotFlowId: a.id });
    expect((await request(app).delete(`/api/automations/${a.id}`)).status).toBe(200);
    expect(H.db.conversation[0]).toMatchObject({ automationRunId: null, chatbotNodeId: null, chatbotFlowId: null });
  });
});

describe("★ validation rules (pure)", () => {
  const v = (trigger: any, g = goodGraph()) => validateAutomation(trigger, g.nodes as any, g.edges as any);

  it("the example automation is valid", () => {
    expect(v(msgTrigger).errors).toEqual([]);
  });

  it("a schedule or webhook path has no customer: send steps cannot run there", () => {
    const codes = v({ type: "schedule", config: { at: "09:00" } }).errors.map((e) => e.code);
    expect(codes).toContain("no_customer_on_path");
  });

  it("channel limits: a list is WhatsApp only; buttons reach 3; titles reach 20", () => {
    const g = goodGraph();
    g.nodes.push({ id: "l", type: "send_list", data: { text: "x", buttonText: "y", options: [{ id: "o", title: "a" }] } } as any);
    g.edges.push({ id: "e7", source: "task", target: "l" });
    expect(v({ type: "message_received", config: { channels: ["INSTAGRAM"] } }, g).errors.map((e) => e.code)).toContain("channel_not_supported");
    (g.nodes[2].data as any).buttons[0].title = "x".repeat(21);
    expect(v(msgTrigger, g).errors.map((e) => e.code)).toContain("title_too_long");
  });

  it("a branch that does not exist, and a step after a hand-over, are errors", () => {
    const g = goodGraph();
    g.edges.push({ id: "e8", source: "w", target: "closed", sourceHandle: "btn:nope" });
    expect(v(msgTrigger, g).errors.map((e) => e.code)).toContain("unknown_branch");
    const g2 = goodGraph();
    g2.edges.push({ id: "e9", source: "ai", target: "closed" });
    expect(v(msgTrigger, g2).errors.map((e) => e.code)).toContain("no_output");
  });

  it("wait for reply branches on the buttons of the message before it, plus reply and timeout", () => {
    const g = goodGraph();
    expect(outputsOf(g.nodes[3] as any, g.nodes as any, g.edges as any)).toEqual(["btn:call", "btn:write", "reply", "timeout"]);
  });

  it("a trigger with no event source cannot go live; a call trigger needs a line", () => {
    expect(v({ type: "form_submitted", config: {} }).errors.map((e) => e.code)).toContain("trigger_no_event_source");
    const tpl = { nodes: [{ id: "t", type: "automation_trigger", data: {} }, { id: "s", type: "send_message_template", data: { templateId: "tpl1" } }], edges: [{ id: "e", source: "t", target: "s" }] };
    const codes = (ctx: any) => validateAutomation({ type: "call_missed", config: {} }, tpl.nodes as any, tpl.edges as any, ctx).errors.map((e) => e.code);
    expect(codes({ voiceConnected: true })).toEqual([]);
    expect(codes({ voiceConnected: false }).join(" ")).toMatch(/not_connected|voice/);
  });

  it("normalizeTrigger keeps only the fields its type reads", () => {
    expect(normalizeTrigger({ type: "message_received", config: { keywords: [" catalogue ", "catalogue"], junk: 1 } }))
      .toEqual({ type: "message_received", config: { keywords: ["catalogue"], match: "contains" } });
  });
});

describe("the catalogue (09e)", () => {
  const items = (body: any) => Object.fromEntries(body.data.groups.flatMap((g: any) => g.items.map((i: any) => [i.type, i])));

  it("first step: only triggers; form/story have no source; calls need a line", async () => {
    const it0 = items((await request(app).get("/api/automations/catalog")).body);
    expect(it0["trigger:message_received"]).toMatchObject({ available: true });
    expect(it0["trigger:form_submitted"]).toMatchObject({ available: false, reason: "no_event_source" });
    expect(it0["trigger:call_missed"]).toMatchObject({ available: false, reason: "not_connected" });
    expect(it0.send_buttons).toMatchObject({ available: false, reason: "first_step_only" });
  });

  it("mid-path: triggers are first-step-only, sends follow the path's channel and customer", async () => {
    const a = await create({ ...goodGraph(), trigger: { type: "message_received", config: { channels: ["INSTAGRAM"] } } });
    const mid = items((await request(app).get(`/api/automations/catalog?automationId=${a.id}&after=b`)).body);
    expect(mid["trigger:message_received"]).toMatchObject({ available: false, reason: "first_step_only" });
    expect(mid.send_list).toMatchObject({ available: false, reason: "channel_not_supported" });
    expect(mid.send_buttons).toMatchObject({ available: true, limits: { maxButtons: 3, titleMax: 20 } });
    expect(mid.send_location).toMatchObject({ available: false, reason: "coming_later" });
    const s = await create({ ...goodGraph(), trigger: { type: "schedule", config: { at: "09:00" } } });
    const sched = (await request(app).get(`/api/automations/catalog?automationId=${s.id}&after=t`)).body.data;
    expect(items({ data: sched }).send_message_text).toMatchObject({ available: false, reason: "no_customer_on_path" });
    expect(sched.context.hasCustomer).toBe(false);
  });
});

describe("★ the run log", () => {
  async function seedRuns() {
    const a = await create(goodGraph());
    const t = Date.now();
    H.db.automationRun.push(
      { id: "r_sales", tenantId: "T", flowId: a.id, triggerType: "message_received", status: "completed", conversationId: "c_sales", contactId: "k1", answeredInbound: true, startedAt: new Date(t - 3000) },
      { id: "r_support", tenantId: "T", flowId: a.id, triggerType: "message_received", status: "failed", error: "send_failed: x", conversationId: "c_support", contactId: null, answeredInbound: false, startedAt: new Date(t - 2000) },
      { id: "r_hook", tenantId: "T", flowId: a.id, triggerType: "message_received", status: "waiting", conversationId: null, contactId: null, answeredInbound: false, startedAt: new Date(t - 1000) },
      { id: "r_x", tenantId: "X", flowId: "other_t", triggerType: "message_received", status: "completed", conversationId: null, startedAt: new Date(t) },
    );
    H.db.automationRunStep.push(
      { id: "s1", tenantId: "T", runId: "r_sales", nodeId: "b", nodeType: "send_buttons", status: "ok", branch: null, at: new Date(t) },
      { id: "s2", tenantId: "T", runId: "r_support", nodeId: "b", nodeType: "send_buttons", status: "failed", branch: null, at: new Date(t) },
      { id: "s3", tenantId: "T", runId: "r_sales", nodeId: "w", nodeType: "wait_for_reply", status: "waiting", branch: null, at: new Date(t) },
      { id: "s4", tenantId: "T", runId: "r_sales", nodeId: "w", nodeType: "wait_for_reply", status: "ok", branch: "btn:call", at: new Date(t + 1) },
    );
    return a;
  }

  it("newest first, with the contact and whether the run answered the message; stats on the row", async () => {
    const a = await seedRuns();
    const runs = (await request(app).get(`/api/automations/${a.id}/runs`)).body;
    expect(runs.data.map((r: any) => r.id)).toEqual(["r_hook", "r_support", "r_sales"]);
    expect(runs.data[2]).toMatchObject({ contact: { id: "k1", name: "Dana" }, answeredInbound: true, status: "completed" });
    const row = (await request(app).get(`/api/automations/${a.id}`)).body.data;
    expect(row.stats).toMatchObject({ runsThisWeek: 3, lastRunStatus: "waiting" });
  });

  it("★ a restricted viewer does not see runs in other departments' conversations; paging uses the raw page", async () => {
    const a = await seedRuns();
    H.viewer = { userId: "agent1", role: "AGENT", departmentId: "sales" };
    const p1 = (await request(app).get(`/api/automations/${a.id}/runs?limit=2`)).body;
    expect(p1.data.map((r: any) => r.id)).toEqual(["r_hook"]); // r_support hidden
    expect(p1.nextCursor).toBe("r_support"); // the raw boundary, so paging continues
    const p2 = (await request(app).get(`/api/automations/${a.id}/runs?limit=2&cursor=${p1.nextCursor}`)).body;
    expect(p2.data.map((r: any) => r.id)).toEqual(["r_sales"]);
    expect((await request(app).get("/api/automations/runs/r_support")).status).toBe(404);
  });

  it("one run with its node trace; another tenant's run is 404", async () => {
    await seedRuns();
    const r = (await request(app).get("/api/automations/runs/r_sales")).body.data;
    expect(r.steps.map((s: any) => [s.nodeId, s.status, s.branch])).toEqual([["b", "ok", null], ["w", "waiting", null], ["w", "ok", "btn:call"]]);
    expect((await request(app).get("/api/automations/runs/r_x")).status).toBe(404);
  });

  it("node stats: reached, failed, and the branch taken (\"Sent 2 times, 1 tapped a button\")", async () => {
    const a = await seedRuns();
    const s = (await request(app).get(`/api/automations/${a.id}/node-stats`)).body.data;
    expect(s.b).toEqual({ reached: 2, failed: 1, branches: {} });
    expect(s.w).toEqual({ reached: 1, failed: 0, branches: { "btn:call": 1 } });
  });
});

describe("★ reading automations needs ai:workflows:read", () => {
  it("every read door answers 403 without the permission, and with it as before", async () => {
    const a = await create(goodGraph());
    H.db.automationRun.push({ id: "r1", tenantId: "T", flowId: a.id, triggerType: "message_received", status: "completed", conversationId: null, startedAt: new Date() });
    const reads: Array<[string, string]> = [
      ["get", "/api/automations"], ["get", "/api/automations/catalog"], ["get", `/api/automations/${a.id}`],
      ["get", `/api/automations/${a.id}/runs`], ["get", "/api/automations/runs/r1"], ["get", `/api/automations/${a.id}/node-stats`],
      ["post", `/api/automations/${a.id}/validate`],
    ];
    H.lacking = new Set(["ai:workflows:read"]);
    for (const [m, path] of reads) {
      const r = await (request(app) as any)[m](path).send({});
      expect(r.status, path).toBe(403);
      expect(r.body.data, path).toBeUndefined();
    }
    H.lacking = new Set();
    for (const [m, path] of reads) expect((await (request(app) as any)[m](path).send({})).status, path).toBe(200);
  });

  it("read does not imply write: with read but not update, a save is 403", async () => {
    const a = await create(goodGraph());
    H.lacking = new Set(["ai:workflows:update"]);
    expect((await request(app).get(`/api/automations/${a.id}`)).status).toBe(200);
    expect((await request(app).put(`/api/automations/${a.id}`).send({ name: "x" })).status).toBe(403);
  });
});

describe("message from an ad, button tapped, AI writes a message", () => {
  it("the two triggers are live and keep only their own config", () => {
    expect(normalizeTrigger({ type: "message_from_ad", config: { adIds: [" 120201 ", "120201"], keywords: ["x"] } })).toEqual({ type: "message_from_ad", config: { adIds: ["120201"] } });
    expect(normalizeTrigger({ type: "button_tapped", config: { payloads: ["call_me"], channels: ["WHATSAPP"] } })).toEqual({ type: "button_tapped", config: { channels: ["WHATSAPP"], payloads: ["call_me"] } });
    const g = goodGraph();
    expect(validateAutomation({ type: "message_from_ad", config: {} }, g.nodes as any, g.edges as any).errors).toEqual([]);
    expect(validateAutomation({ type: "button_tapped", config: {} }, g.nodes as any, g.edges as any).errors).toEqual([]);
  });

  it("AI writes a message needs its instruction and the employee who writes it", () => {
    const g = goodGraph();
    g.nodes.push({ id: "ai2", type: "ai_generate", data: {} } as any);
    g.edges.push({ id: "e9", source: "task", target: "ai2" });
    const codes = validateAutomation(msgTrigger, g.nodes as any, g.edges as any).errors.filter((e) => e.nodeId === "ai2").map((e) => e.message);
    expect(codes.join(" ")).toMatch(/prompt/);
    expect(codes.join(" ")).toMatch(/AI employee/);
  });
});

describe("★ cart left behind", () => {
  const cartGraph = (nodeType: string, data: any) => ({
    nodes: [{ id: "t", type: "automation_trigger", data: {} }, { id: "s", type: nodeType, data }],
    edges: [{ id: "e", source: "t", target: "s" }],
  });

  it("is live, says it needs consent, and keeps a 15 min - 2 day delay", async () => {
    const it0 = Object.fromEntries((await request(app).get("/api/automations/catalog")).body.data.groups.flatMap((g: any) => g.items.map((i: any) => [i.type, i])));
    expect(it0["trigger:cart_abandoned"]).toMatchObject({ available: true, description: expect.stringMatching(/agreed to marketing/) });
    // No channel on the trigger (2026-10-14): the first send step decides.
    expect(normalizeTrigger({ type: "cart_abandoned", config: { delayMinutes: 90, channels: ["WHATSAPP"] } })).toEqual({ type: "cart_abandoned", config: { delayMinutes: 90 } });
    expect(it0["trigger:cart_abandoned"].channels).toEqual([]);
    expect(() => normalizeTrigger({ type: "cart_abandoned", config: { delayMinutes: 5 } })).toThrow(/15 minutes/);
  });

  it("★ on WhatsApp only a template: a plain message is refused with the reason; by email free text is fine", () => {
    const wa = cartGraph("send_message_text", { text: "You left something behind", via: "whatsapp" });
    const errs = validateAutomation({ type: "cart_abandoned", config: {} }, wa.nodes as any, wa.edges as any).errors;
    expect(errs.map((e) => e.code)).toContain("needs_24h_window");
    expect(errs.find((e) => e.code === "needs_24h_window")!.message).toMatch(/template/);
    const t = cartGraph("send_message_template", { templateId: "tpl1" });
    expect(validateAutomation({ type: "cart_abandoned", config: {} }, t.nodes as any, t.edges as any).errors).toEqual([]);
    const mail = cartGraph("send_message_text", { text: "You left something behind", via: "email", subject: "Your cart" });
    expect(validateAutomation({ type: "cart_abandoned", config: {} }, mail.nodes as any, mail.edges as any).errors).toEqual([]);
    // No via on a plain first message: it has to say how it reaches the customer.
    const none = cartGraph("send_message_text", { text: "You left something behind" });
    expect(validateAutomation({ type: "cart_abandoned", config: {} }, none.nodes as any, none.edges as any).errors.map((e) => e.code)).toContain("via_required");
  });

  it("★ the unreachable branch: tried on the other channel, and only from the first message", () => {
    const cart = { type: "cart_abandoned", config: {} };
    const nodes = [
      { id: "t", type: "automation_trigger", data: {} },
      { id: "wa", type: "send_message_template", data: { templateId: "tpl1" } },
      { id: "em", type: "send_message_text", data: { text: "Your cart", via: "email", subject: "Cart" } },
      { id: "em2", type: "send_message_text", data: { text: "Still there?", via: "email" } },
    ];
    const edges = [
      { id: "1", source: "t", target: "wa" },
      { id: "2", source: "wa", target: "em", sourceHandle: "unreachable" },
      { id: "3", source: "em", target: "em2" },
    ];
    // The email branch is judged as email: free text there is fine.
    expect(validateAutomation(cart, nodes as any, edges as any).errors).toEqual([]);
    const codes = (n: any[], e: any[], reach?: any) => validateAutomation(cart, n as any, e as any, { voiceConnected: true, reach }).errors.map((x) => x.code);
    // Same channel on the branch.
    expect(codes(nodes.map((n) => (n.id === "em" ? { ...n, data: { ...n.data, via: "whatsapp" } } : n)), edges)).toContain("unreachable_same_channel");
    // A later step on the branch naming the other channel.
    expect(codes(nodes.map((n) => (n.id === "em2" ? { ...n, data: { ...n.data, via: "whatsapp" } } : n)), edges)).toContain("via_mismatch");
    // "unreachable" from a later step.
    expect(codes(nodes, [...edges, { id: "4", source: "em", target: "em2", sourceHandle: "unreachable" }])).toContain("unreachable_only_on_first_send");
    // No mail account: the email branch cannot run.
    expect(codes(nodes, edges, { whatsapp: true, email: false })).toContain("via_not_connected");
    // Outside a cart automation there is no such exit.
    expect(validateAutomation({ type: "message_received", config: {} }, nodes as any, edges as any).errors.map((x) => x.code)).toContain("unreachable_only_on_first_send");
  });

  it("★ the catalogue of a cart automation: reach, its plan, and the channels each send step can use", async () => {
    H.db.channelAccount.push({ id: "wa1", tenantId: "T", channel: "WHATSAPP", isActive: true }, { id: "gm1", tenantId: "T", channel: "GMAIL", isActive: true });
    const g = cartGraph("send_message_text", { text: "hi", via: "email", subject: "Cart" });
    const c = await create({ ...g, trigger: { type: "cart_abandoned", config: {} } });
    const d = (await request(app).get(`/api/automations/catalog?automationId=${c.id}&after=s`)).body.data;
    expect(d.context).toMatchObject({ channel: "EMAIL", reach: { whatsapp: true, email: true }, cart: { firstSendStepId: "s", via: "email", fallbackStepId: null } });
    const items = Object.fromEntries(d.groups.flatMap((gr: any) => gr.items.map((i: any) => [i.type, i])));
    expect(items.send_message_text.viaOptions).toEqual(["whatsapp", "email"]);
    expect(items.send_message_template.viaOptions).toEqual(["whatsapp"]);
  });

  it("the catalogue offers the cart variables", async () => {
    const g = cartGraph("send_message_template", { templateId: "tpl1" });
    const c = await create({ ...g, trigger: { type: "cart_abandoned", config: {} } });
    const d = (await request(app).get(`/api/automations/catalog?automationId=${c.id}&after=t`)).body.data;
    expect(d.variables).toEqual(expect.arrayContaining(["cart_url", "cart_total", "cart_items", "first_name"]));
  });

  it("a tag automation is not refused (the customer is usually mid-conversation)", () => {
    const g = cartGraph("send_message_text", { text: "hi" });
    expect(validateAutomation({ type: "tag_added", config: { tags: ["vip"] } }, g.nodes as any, g.edges as any).errors).toEqual([]);
  });
});

describe("★ comment on a post", () => {
  const T = (config: any = {}) => ({ type: "comment_received", config });
  const graph = (...chain: Array<[string, any]>) => {
    const nodes: any[] = [{ id: "t", type: "automation_trigger", data: {} }, ...chain.map(([type, data], i) => ({ id: `n${i}`, type, data }))];
    const edges = chain.map((_, i) => ({ id: `e${i}`, source: i ? `n${i - 1}` : "t", target: `n${i}` }));
    return { nodes, edges };
  };
  const errs = (g: any, t: any = T()) => validateAutomation(t, g.nodes, g.edges).errors;

  it("is live; keeps channels (Instagram / Facebook only), posts and keywords", async () => {
    const it0 = Object.fromEntries((await request(app).get("/api/automations/catalog")).body.data.groups.flatMap((g: any) => g.items.map((i: any) => [i.type, i])));
    expect(it0["trigger:comment_received"]).toMatchObject({ available: true });
    expect(normalizeTrigger({ type: "comment_received", config: { channels: ["INSTAGRAM"], postIds: [" 1789 ", "1789"], keywords: ["price"], delayMinutes: 9 } }))
      .toEqual({ type: "comment_received", config: { channels: ["INSTAGRAM"], postIds: ["1789"], keywords: ["price"], match: "contains" } });
    expect(() => normalizeTrigger({ type: "comment_received", config: { channels: ["WHATSAPP"] } })).toThrow(/INSTAGRAM or MESSENGER/);
  });

  it("public reply, a DM with buttons, wait, then anything: valid", () => {
    const g = graph(
      ["send_comment_reply", { mode: "text", text: "Sent you a DM!" }],
      ["send_buttons", { text: "Want the price list?", buttons: [{ id: "y", title: "Yes" }] }],
      ["wait_for_reply", { timeoutMs: 3_600_000 }],
      ["hand_to_ai", { aiAgentId: "maya" }],
    );
    (g.edges[3] as any).sourceHandle = "btn:y"; // the Yes button
    expect(errs(g)).toEqual([]);
  });

  it("★ a step the comment walker cannot run, before the customer replies, is refused", () => {
    const codes = errs(graph(["hand_to_ai", { aiAgentId: "maya" }])).map((e) => e.code);
    expect(codes).toContain("comment_step_unsupported");
  });

  it("★ a public reply outside a comment automation, or after a wait, is refused", () => {
    expect(errs(graph(["send_comment_reply", { text: "hi" }]), msgTrigger).map((e) => e.code)).toContain("comment_reply_misplaced");
    const late = graph(["send_message_text", { text: "hi" }], ["wait_for_reply", { timeoutMs: 60_000 }], ["send_comment_reply", { text: "x" }]);
    expect(errs(late).map((e) => e.code)).toContain("comment_reply_misplaced");
  });

  it("★ the catalogue: on the comment only the comment walker's steps and variables; after the reply, everything", async () => {
    const g = graph(
      ["send_comment_reply", { mode: "text", text: "Sent you a DM!" }],
      ["send_buttons", { text: "Want it?", buttons: [{ id: "y", title: "Yes" }] }],
      ["wait_for_reply", { timeoutMs: 3_600_000 }],
      ["send_message_text", { text: "Here" }],
    );
    (g.edges[3] as any).sourceHandle = "btn:y";
    const a = await create({ ...g, trigger: T() });
    const at = async (after: string) => (await request(app).get(`/api/automations/catalog?automationId=${a.id}&after=${after}`)).body.data;
    const items = (d: any) => Object.fromEntries(d.groups.flatMap((x: any) => x.items.map((i: any) => [i.type, i])));
    const onComment = await at("n0");
    expect(items(onComment).hand_to_ai).toMatchObject({ available: false, reason: "after_customer_replies" });
    expect(items(onComment).send_comment_reply).toMatchObject({ available: true });
    expect(onComment.variables).toContain("comment.from.username");
    expect(onComment.variables).not.toContain("first_name");
    const afterReply = await at("n3");
    expect(items(afterReply).hand_to_ai).toMatchObject({ available: true });
    expect(items(afterReply).send_comment_reply).toMatchObject({ available: false, reason: "comment_automation_only" });
    expect(afterReply.variables).toEqual(expect.arrayContaining(["first_name", "comment.text"]));
    // A message automation never offers the public reply.
    const m = await create({ ...goodGraph(), trigger: msgTrigger });
    const mid = (await request(app).get(`/api/automations/catalog?automationId=${m.id}&after=b`)).body.data;
    expect(items(mid).send_comment_reply).toMatchObject({ available: false, reason: "comment_automation_only" });
    expect(mid.variables).toEqual(["first_name", "business_name", "opening_hours"]);
  });

  it("the public reply needs its text, or its AI employee", () => {
    expect(errs(graph(["send_comment_reply", { mode: "text" }])).map((e) => e.message).join(" ")).toMatch(/Write the reply/);
    expect(errs(graph(["send_comment_reply", { mode: "ai" }])).map((e) => e.message).join(" ")).toMatch(/AI employee/);
    expect(errs(graph(["send_comment_reply", { mode: "ai", agentId: "maya" }]))).toEqual([]);
  });
});

describe("★ call missed / call answered", () => {
  const items = (d: any) => Object.fromEntries(d.groups.flatMap((x: any) => x.items.map((i: any) => [i.type, i])));
  const tplGraph = (type = "send_message_template", data: any = { templateId: "tpl1" }) => ({
    nodes: [{ id: "t", type: "automation_trigger", data: {} }, { id: "s", type, data }],
    edges: [{ id: "e", source: "t", target: "s" }],
  });

  it("live once a voice line (an ACTIVE voice channel) exists; a pending line does not count", async () => {
    H.db.communicationChannel = [{ id: "line1", tenantId: "T", channelType: "VOICE", status: "PENDING" }];
    let it0 = items((await request(app).get("/api/automations/catalog")).body.data);
    expect(it0["trigger:call_missed"]).toMatchObject({ available: false, reason: "not_connected" });
    H.db.communicationChannel[0].status = "ACTIVE";
    it0 = items((await request(app).get("/api/automations/catalog")).body.data);
    expect(it0["trigger:call_missed"]).toMatchObject({ available: true, description: expect.stringMatching(/WhatsApp, with a template/) });
    expect(it0["trigger:call_answered"]).toMatchObject({ available: true });
  });

  it("★ the reply goes to WhatsApp, template only: a plain message is refused and dimmed", async () => {
    const plain = tplGraph("send_message_text", { text: "Sorry we missed you" });
    for (const type of ["call_missed", "call_answered"]) {
      expect(validateAutomation({ type, config: {} }, plain.nodes as any, plain.edges as any, { voiceConnected: true }).errors.map((e) => e.code)).toContain("needs_24h_window");
    }
    H.db.communicationChannel = [{ id: "line1", tenantId: "T", channelType: "VOICE", status: "ACTIVE" }];
    const a = await create({ ...tplGraph(), trigger: { type: "call_missed", config: { lines: ["line1"] } } });
    const d = (await request(app).get(`/api/automations/catalog?automationId=${a.id}&after=t`)).body.data;
    expect(d.context.channel).toBe("WHATSAPP");
    expect(items(d).send_message_text).toMatchObject({ available: false, reason: "needs_24h_window" });
    expect(items(d).send_message_template).toMatchObject({ available: true });
    expect(d.variables).toEqual(expect.arrayContaining(["caller_number", "line_name", "call_duration", "call_recording_url", "first_name"]));
  });
});

describe("★ order event", () => {
  const items = (d: any) => Object.fromEntries(d.groups.flatMap((x: any) => x.items.map((i: any) => [i.type, i])));
  const g = (type: string, data: any) => ({
    nodes: [{ id: "t", type: "automation_trigger", data: {} }, { id: "s", type, data }],
    edges: [{ id: "e", source: "t", target: "s" }],
  });

  it("is live; keeps channels and statuses, refuses an unknown status", async () => {
    const it0 = items((await request(app).get("/api/automations/catalog")).body.data);
    expect(it0["trigger:order_event"]).toMatchObject({ available: true, description: expect.stringMatching(/Shopify or WooCommerce/) });
    expect(normalizeTrigger({ type: "order_event", config: { statuses: ["fulfilled", "fulfilled"], channels: ["WHATSAPP"], delayMinutes: 5 } }))
      .toEqual({ type: "order_event", config: { channels: ["WHATSAPP"], statuses: ["fulfilled"] } });
    expect(() => normalizeTrigger({ type: "order_event", config: { statuses: ["delivered"] } })).toThrow(/created, paid, fulfilled, cancelled/);
  });

  it("★ WhatsApp: template only; e-mail only may be free text; the catalogue offers the order variables", async () => {
    const plain = g("send_message_text", { text: "Your order {{order_number}} shipped" });
    expect(validateAutomation({ type: "order_event", config: {} }, plain.nodes as any, plain.edges as any).errors.map((e) => e.code)).toContain("needs_24h_window");
    expect(validateAutomation({ type: "order_event", config: { channels: ["EMAIL"] } }, plain.nodes as any, plain.edges as any).errors).toEqual([]);
    const a = await create({ ...g("send_message_template", { templateId: "tpl1" }), trigger: { type: "order_event", config: { statuses: ["fulfilled"] } } });
    const d = (await request(app).get(`/api/automations/catalog?automationId=${a.id}&after=t`)).body.data;
    expect(d.variables).toEqual(expect.arrayContaining(["order_number", "order_total", "order_status", "order_items", "order_url", "first_name"]));
  });
});

describe("story mention", () => {
  it("is live, on Instagram, with the story's link as a variable", async () => {
    const items = (d: any) => Object.fromEntries(d.groups.flatMap((x: any) => x.items.map((i: any) => [i.type, i])));
    expect(items((await request(app).get("/api/automations/catalog")).body.data)["trigger:story_mention"]).toMatchObject({ available: true, channels: ["INSTAGRAM"] });
    const a = await create({ ...goodGraph(), trigger: { type: "story_mention", config: {} } });
    const d = (await request(app).get(`/api/automations/catalog?automationId=${a.id}&after=t`)).body.data;
    expect(d.context.channel).toBe("INSTAGRAM");
    expect(items(d).send_list).toMatchObject({ available: false, reason: "channel_not_supported" });
    expect(d.variables).toEqual(expect.arrayContaining(["story_url", "first_name"]));
  });
});

describe("★ 2026-10-14: page on a comment trigger, message waits, catalogue facts", () => {
  it("a comment trigger may name its page; a malformed id is refused", () => {
    expect(normalizeTrigger({ type: "comment_received", config: { channelAccountId: "cmabc123", postIds: ["p1"] } }).config)
      .toMatchObject({ channelAccountId: "cmabc123", postIds: ["p1"] });
    expect(normalizeTrigger({ type: "comment_received", config: { channelAccountId: "" } }).config).not.toHaveProperty("channelAccountId");
    expect(() => normalizeTrigger({ type: "comment_received", config: { channelAccountId: "../../x" } })).toThrow(/channelAccountId/);
  });

  it("★ a message that waits for the reply is a wait boundary for comment automations", () => {
    const nodes = [
      { id: "t", type: "automation_trigger" },
      { id: "m", type: "send_message_text", data: { text: "Size?", waitForReply: true } },
      { id: "after", type: "send_location", data: {} },
    ];
    const edges = [{ source: "t", target: "m" }, { source: "m", target: "after" }];
    const pre = beforeFirstWait(nodes as any, edges as any);
    expect([...pre].sort()).toEqual(["m", "t"]);
    // Without the wait, the next step is still on the comment.
    expect([...beforeFirstWait([nodes[0], { ...nodes[1], data: { text: "Size?" } }, nodes[2]] as any, edges as any)].sort()).toEqual(["after", "m", "t"]);
  });

  it("★ each catalogue item says whether it sends and whether it may run on the comment", () => {
    const cat: any = catalogFor({ channel: null, firstStep: false, triggerType: "message_received", afterNodeType: null, voiceConnected: false });
    const all = cat.groups.flatMap((g: any) => g.items);
    const by = Object.fromEntries(all.map((i: any) => [i.type, i]));
    expect(by.send_message_text).toMatchObject({ sends: true, commentSafe: true });
    expect(by.wait).toMatchObject({ sends: false, commentSafe: false });
    expect(by.add_tag).toMatchObject({ sends: false });
    expect(all.every((i: any) => typeof i.sends === "boolean" && typeof i.commentSafe === "boolean")).toBe(true);
  });
});
