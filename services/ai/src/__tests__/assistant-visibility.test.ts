/**
 * The assistant (Cmd-K today, the Home chat next) sees no more than its user:
 *   - ★ system_* tools: a department-restricted user's counts, metrics and
 *     recent activity carry the inbox's visibility clause; a conversation they
 *     cannot see reads as missing (and its messages are never read); an ADMIN
 *     is unrestricted
 *   - ★ the context block: a selected conversation they cannot see is dropped,
 *     and the recent-activity lines are filtered the same way
 *   - ★ the route: needs conversation:messages:read; the client cannot pick
 *     the model; an employee id from another workspace is ignored
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({
  conversations: [] as any[],
  calls: [] as Array<{ model: string; op: string; where: any }>,
  allowed: true,
  permArgs: [] as any[],
  runInput: null as any,
  workspaceLocale: "he" as string,
  agents: [] as any[],
}));

/** Does a conversation row pass the where clause's visibility OR? */
function visible(row: any, where: any): boolean {
  if (!where?.OR) return true;
  return where.OR.some((c: any) => Object.entries(c).every(([k, v]) => (row[k] ?? null) === v));
}

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const record = (model: string, op: string) => async (a: any = {}) => {
    H.calls.push({ model, op, where: a.where });
    if (model === "conversation" && op === "findFirst") {
      return H.conversations.find((c) => c.id === a.where.id && c.tenantId === a.where.tenantId && visible(c, a.where)) ?? null;
    }
    if (model === "aIAgent" && op === "findFirst") {
      return H.agents.find((x) => x.id === a.where.id && x.tenantId === a.where.tenantId) ?? null;
    }
    if (op === "count") return 0;
    if (op === "findMany") return [];
    if (op === "findUnique") return model === "user" ? { id: "u1", name: "Rina", email: "r@x", role: "AGENT", tenantId: "T" } : { name: "Acme" };
    return null;
  };
  const table = (model: string) => ({
    findFirst: record(model, "findFirst"), findMany: record(model, "findMany"),
    findUnique: record(model, "findUnique"), count: record(model, "count"),
  });
  return {
    ...actual,
    resolveEffectiveLocale: async () => ({ effective: H.workspaceLocale }),
    prisma: {
      conversation: table("conversation"), message: table("message"), contact: table("contact"),
      user: table("user"), tenant: table("tenant"), aIAgent: table("aIAgent"), approvalRequest: table("approvalRequest"),
    },
    authenticate: (req: any, _res: any, next: any) => { req.user = { userId: "u1", role: "AGENT", departmentId: "sales" }; next(); },
    resolveTenant: (req: any, _res: any, next: any) => { req.tenantId = "T"; next(); },
    requireActiveTenant: () => (_req: any, _res: any, next: any) => next(),
    requirePermissionOrRole: (...args: any[]) => {
      H.permArgs.push(args);
      return (_req: any, res: any, next: any) => (H.allowed ? next() : res.status(403).json({ error: "Forbidden" }));
    },
  };
});
vi.mock("../services/agent-runtime.service", () => ({
  runAgent: async (input: any) => { H.runInput = input; },
}));

import { dispatchSystemToolCall } from "../services/system-tools.service";
import { buildAgentContext } from "../services/agent-context.service";
import agentRouter from "../routes/agent";

const restricted = { userId: "u1", role: "AGENT", departmentId: "sales" };
const admin = { userId: "a1", role: "ADMIN" };
const call = (name: string, args: any = {}) => ({ id: "tc1", function: { name, arguments: JSON.stringify(args) } });
const ctx = (viewer: any) => ({ tenantId: "T", userId: viewer.userId, viewer });
const whereOf = (model: string, op: string) => H.calls.filter((c) => c.model === model && c.op === op).map((c) => c.where);

beforeEach(() => {
  H.calls = []; H.allowed = true; H.runInput = null;
  H.conversations = [
    { id: "c_sales", tenantId: "T", departmentId: "sales", assignedAgentId: null },
    { id: "c_support", tenantId: "T", departmentId: "support", assignedAgentId: null },
  ];
  H.agents = [{ id: "ag_mine", tenantId: "T" }, { id: "ag_other", tenantId: "OTHER" }];
});

describe("★ system_* tools follow the inbox's visibility", () => {
  it("counts and metrics carry the clause for a restricted user, not for an ADMIN", async () => {
    await dispatchSystemToolCall(call("system_count_conversations", { status: "OPEN" }), ctx(restricted));
    await dispatchSystemToolCall(call("system_get_metric", { metric: "open_conversations" }), ctx(restricted));
    await dispatchSystemToolCall(call("system_get_metric", { metric: "inbound_messages_24h" }), ctx(restricted));
    const convCounts = whereOf("conversation", "count");
    expect(convCounts).toHaveLength(2);
    for (const w of convCounts) expect(w.OR).toEqual(expect.arrayContaining([{ assignedAgentId: "u1" }, { departmentId: "sales", assignedAgentId: null }]));
    expect(whereOf("message", "count")[0].conversation.OR).toBeDefined();

    H.calls = [];
    await dispatchSystemToolCall(call("system_count_conversations", {}), ctx(admin));
    await dispatchSystemToolCall(call("system_get_metric", { metric: "open_conversations" }), ctx(admin));
    for (const w of whereOf("conversation", "count")) expect(w.OR).toBeUndefined();
  });

  it("★ summarizing another department's conversation reads as missing, and its messages are never read", async () => {
    const r = await dispatchSystemToolCall(call("system_summarize_conversation", { conversationId: "c_support" }), ctx(restricted));
    expect(JSON.parse(r.content)).toEqual({ ok: false, error: "conversation not found" });
    expect(whereOf("message", "findMany")).toEqual([]);
    const ok = await dispatchSystemToolCall(call("system_summarize_conversation", { conversationId: "c_sales" }), ctx(restricted));
    expect(JSON.parse(ok.content).ok).toBe(true);
    expect(whereOf("message", "findMany")[0]).toMatchObject({ conversationId: "c_sales" });
  });

  it("recent activity is filtered to visible conversations", async () => {
    await dispatchSystemToolCall(call("system_recent_activity", {}), ctx(restricted));
    expect(whereOf("message", "findMany")[0].conversation.OR).toBeDefined();
  });
});

describe("★ the context block", () => {
  it("drops a selected conversation the user cannot see, and filters the recent lines", async () => {
    const op = { tenantId: "T", userId: "u1", viewer: restricted };
    expect((await buildAgentContext({ operator: op, client: { conversationId: "c_support" } })).resolved.conversationId).toBeNull();
    expect((await buildAgentContext({ operator: op, client: { conversationId: "c_sales" } })).resolved.conversationId).toBe("c_sales");
    expect(whereOf("message", "findMany").every((w) => w.conversation?.OR)).toBe(true);
  });
});

describe("★ the route", () => {
  const app = () => { const a = express(); a.use(express.json()); a.use("/api/agent", agentRouter); return a; };

  it("needs conversation:messages:read (403 without it)", async () => {
    expect(H.permArgs).toContainEqual(["conversation:messages:read", "ADMIN"]);
    H.allowed = false;
    expect((await request(app()).post("/api/agent/run").send({ message: "hi", sessionId: "s1" })).status).toBe(403);
    expect(H.runInput).toBeNull();
  });

  it("the client cannot pick the model; another workspace's employee is ignored; the viewer travels", async () => {
    await request(app()).post("/api/agent/run").send({ message: "hi", sessionId: "s1", model: "gpt-5-pro", aiAgentId: "ag_other" });
    expect(H.runInput.model).toBeUndefined();
    expect(H.runInput.aiAgentId).toBeNull();
    expect(H.runInput.operator.viewer).toEqual({ userId: "u1", role: "AGENT", departmentId: "sales" });
    await request(app()).post("/api/agent/run").send({ message: "hi", sessionId: "s1", aiAgentId: "ag_mine" });
    expect(H.runInput.aiAgentId).toBe("ag_mine");
  });

  it("★ the interface language: the body's locale, then one deliberate header tag, then the user's / workspace's", async () => {
    H.workspaceLocale = "en";
    await request(app()).post("/api/agent/run").set("Accept-Language", "en-US").send({ message: "hi", sessionId: "s1", locale: "he" });
    expect(H.runInput.operator.locale).toBe("he");
    // A browser's list says nothing about the page.
    H.workspaceLocale = "he";
    await request(app()).post("/api/agent/run").set("Accept-Language", "en-US,en;q=0.9").send({ message: "hi", sessionId: "s1" });
    expect(H.runInput.operator.locale).toBe("he");
    // The v2 app's single tag is the page's language.
    await request(app()).post("/api/agent/run").set("Accept-Language", "en").send({ message: "hi", sessionId: "s1" });
    expect(H.runInput.operator.locale).toBe("en");
    H.workspaceLocale = "en";
    await request(app()).post("/api/agent/run").set("Accept-Language", "he-IL,he;q=0.9").send({ message: "hi", sessionId: "s1" });
    expect(H.runInput.operator.locale).toBe("en");
  });
});
