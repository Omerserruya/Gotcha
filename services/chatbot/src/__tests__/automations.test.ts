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
    },
  };
});

import automations from "../routes/automations";
import chatbot from "../routes/chatbot";
import { validateAutomation, outputsOf, normalizeTrigger } from "../lib/automation-catalog";

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
    expect(v({ type: "order_event", config: {} }).errors.map((e) => e.code)).toContain("trigger_no_event_source");
    const g = goodGraph();
    // Not wired to the dispatcher yet: unavailable even WITH a voice line.
    expect(validateAutomation({ type: "call_missed", config: {} }, g.nodes as any, g.edges as any, { voiceConnected: true }).errors.map((e) => e.code)).toContain("trigger_no_event_source");
  });

  it("normalizeTrigger keeps only the fields its type reads", () => {
    expect(normalizeTrigger({ type: "message_received", config: { keywords: [" catalogue ", "catalogue"], junk: 1 } }))
      .toEqual({ type: "message_received", config: { keywords: ["catalogue"], match: "contains" } });
  });
});

describe("the catalogue (09e)", () => {
  const items = (body: any) => Object.fromEntries(body.data.groups.flatMap((g: any) => g.items.map((i: any) => [i.type, i])));

  it("first step: only triggers; order/cart/form/story have no source; calls need a line", async () => {
    const it0 = items((await request(app).get("/api/automations/catalog")).body);
    expect(it0["trigger:message_received"]).toMatchObject({ available: true });
    expect(it0["trigger:order_event"]).toMatchObject({ available: false, reason: "no_event_source" });
    expect(it0["trigger:call_missed"]).toMatchObject({ available: false, reason: "no_event_source" });
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
