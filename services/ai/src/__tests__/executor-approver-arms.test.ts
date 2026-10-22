/**
 * ★ Approved actions that act as the person who approved them (Omer,
 * 2026-10-08): claim / assign / close a conversation, return it to GOTCHA,
 * add a note, answer a customer's question. And the plan around them:
 *   - an approved propose_plan runs its steps (it used to reach the executor
 *     as one step named "propose_plan" and fail: no plan ever ran)
 *   - nothing runs without an approval and an approver; never with the
 *     internal service token (no person to act as)
 *   - each call goes to the app's own route with the APPROVER's token, so
 *     the route checks tenant, visibility and permission at execution time
 *   - a plan with a step that cannot run runs nothing
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const H = vi.hoisted(() => ({ convStatus: {} as Record<string, string>, calls: [] as any[], status: {} as Record<string, number>, audits: [] as any[], contacts: [] as any[], updates: [] as any[] }));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    evaluateToolGate: async () => ({ decision: "ALLOW", reason: "test" }),
    emitTagsAdded: async () => undefined,
    prisma: {
      auditLog: { create: async (a: any) => { H.audits.push(a.data); return {}; }, findFirst: async () => null },
      contact: {
        findFirst: async (a: any) => H.contacts.find((c) => c.id === a.where.id && c.tenantId === a.where.tenantId) ?? null,
        update: async (a: any) => { H.updates.push(a); return { id: a.where.id, tags: a.data.tags }; },
      },
    },
  };
});
vi.mock("../services/policy.service", () => ({ getPolicy: async () => ({}), validateAgainstPolicy: () => ({ ok: true }) }));

import { executeAction } from "../services/action-executor.service";

const APPROVED = { approved: true, approvedBy: "noa", authToken: "Bearer approver-token" };
const run = (tool: string, params: any, ctx: any = APPROVED, tenant = "T") => executeAction(tenant, { tool: tool as any, params, reason: "test", riskLevel: "medium" }, ctx);

beforeEach(() => {
  H.calls = []; H.status = {}; H.convStatus = {}; H.audits = []; H.updates = [];
  H.contacts = [{ id: "k1", tenantId: "T", tags: [] }];
  process.env.CONVERSATION_SERVICE_URL = "http://conversation:4002";
  process.env.INTERNAL_SERVICE_TOKEN = "internal-secret";
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
    H.calls.push({ url, method: init.method, auth: init.headers.Authorization, tenant: init.headers["x-tenant-id"], body: init.body ? JSON.parse(init.body) : null });
    const status = Object.entries(H.status).find(([k]) => url.includes(k))?.[1] ?? 200;
    // GET a conversation: its state as the approver sees it.
    const got = init.method === "GET" ? { data: { status: H.convStatus[url.split("/").pop()!] ?? "OPEN" } } : { data: { ok: true } };
    return { ok: status < 400, status, text: async () => JSON.stringify(status < 400 ? got : { error: status === 404 ? "Conversation not found" : "Forbidden" }) };
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("★ nothing runs without an approval and a person to act as", () => {
  it("not approved, or approved by nobody: refused, no call made", async () => {
    for (const ctx of [{ approved: false, authToken: "Bearer approver-token" }, { approved: true, authToken: "Bearer approver-token" }, {}]) {
      const r = await run("close_conversation", { conversationId: "c1" }, ctx);
      expect(r.ok).toBe(false);
    }
    expect(H.calls).toEqual([]);
  });

  it("★ the internal service token is not a person: an approval decided outside the app fails closed", async () => {
    const r = await run("close_conversation", { conversationId: "c1" }, { approved: true, approvedBy: "whatsapp", authToken: "Bearer internal-secret" });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/approve it in GOTCHA/) });
    expect(H.calls).toEqual([]);
  });
});

describe("★ each action through the app's own route, as the approver", () => {
  it("claim, assign, close, return to GOTCHA, add a note, answer a question", async () => {
    expect((await run("claim_conversation", { conversationId: "c1" })).ok).toBe(true);
    expect((await run("assign_conversation", { conversationId: "c1", agentId: "u2" })).ok).toBe(true);
    expect((await run("close_conversation", { conversationId: "c1" })).ok).toBe(true);
    expect((await run("return_to_gotcha", { conversationId: "c1" })).ok).toBe(true);
    expect((await run("add_note", { contactId: "k1", body: "Prefers evening calls" })).ok).toBe(true);
    expect((await run("answer_question", { unansweredQuestionId: "q1", answer: "Yes, to Eilat in 3 days." })).ok).toBe(true);
    expect(H.calls.filter((c) => c.method === "POST").map((c) => [c.method, c.url, c.body])).toEqual([
      ["POST", "http://conversation:4002/api/conversations/c1/claim", {}],
      ["POST", "http://conversation:4002/api/conversations/c1/reassign", { agentId: "u2" }],
      ["POST", "http://conversation:4002/api/conversations/c1/close", {}],
      ["POST", "http://conversation:4002/api/conversations/c1/return-to-ai", {}],
      ["POST", "http://conversation:4002/api/identity/k1/notes", { body: "Prefers evening calls", visibility: "TEAM" }],
      ["POST", "http://ai:4006/api/knowledge/unanswered-questions/q1/answer", { answer: "Yes, to Eilat in 3 days." }],
    ]);
    // The approver's own token and the plan's workspace on every call.
    expect(new Set(H.calls.map((c) => c.auth))).toEqual(new Set(["Bearer approver-token"]));
    expect(new Set(H.calls.map((c) => c.tenant))).toEqual(new Set(["T"]));
  });

  it("★ checked at execution: a conversation the approver cannot see (or another workspace's) is refused by the route", async () => {
    H.status = { "/c_hidden/": 404 };
    const r = await run("close_conversation", { conversationId: "c_hidden" });
    expect(r).toMatchObject({ ok: false, error: "not found, or not something the approver may change" });
    H.status = { "/c_theirs/": 403 };
    expect((await run("assign_conversation", { conversationId: "c_theirs", agentId: "u2" })).error).toMatch(/not allowed for the approver/);
  });

  it("★ the conversation as it is at execution: closed since it was proposed, already closed, or out of the approver's view: nothing is done", async () => {
    H.convStatus = { c1: "CLOSED" };
    expect((await run("assign_conversation", { conversationId: "c1", agentId: "u2" })).error).toMatch(/closed since this was proposed; nothing was done/);
    expect((await run("return_to_gotcha", { conversationId: "c1" })).error).toMatch(/closed since this was proposed/);
    expect((await run("close_conversation", { conversationId: "c1" })).error).toMatch(/already closed; nothing was done/);
    H.convStatus = {};
    H.status = { "/api/conversations/c_hidden": 404 };
    expect((await run("assign_conversation", { conversationId: "c_hidden", agentId: "u2" })).error).toBe("not found, or not something the approver may change");
    expect(H.calls.filter((c) => c.method === "POST")).toEqual([]);
    // The look runs as the approver too.
    expect(new Set(H.calls.map((c) => c.auth))).toEqual(new Set(["Bearer approver-token"]));
  });

  it("what an action needs is checked before any call", async () => {
    expect((await run("assign_conversation", { conversationId: "c1" })).error).toMatch(/agentId or departmentId is required/);
    expect((await run("add_note", { contactId: "k1", body: "  " })).error).toMatch(/body is required/);
    expect(H.calls).toEqual([]);
  });
});

describe("★ an approved plan runs its steps", () => {
  const plan = (steps: any[]) => run("propose_plan", { summary: "x", steps, conversationId: "c1" });

  it("in order, the plan's conversation given to a step that names none", async () => {
    const r = await plan([
      { tool: "tag_contact", params: { contactId: "k1", tags: ["vip"] }, reason: "a" },
      { tool: "close_conversation", params: {}, reason: "b" },
    ]);
    expect(r.ok).toBe(true);
    expect(H.updates).toHaveLength(1);
    expect(H.calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual(["http://conversation:4002/api/conversations/c1/close"]);
  });

  it("stops at the first step that fails", async () => {
    H.status = { "/c1/close": 404 };
    const r = await plan([
      { tool: "close_conversation", params: {}, reason: "a" },
      { tool: "add_note", params: { contactId: "k1", body: "after" }, reason: "b" },
    ]);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/^step 1 \(close_conversation\) did not run/) });
    expect(H.calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual(["http://conversation:4002/api/conversations/c1/close"]);
  });

  it("★ a plan with a step that cannot run runs nothing at all", async () => {
    const r = await plan([
      { tool: "tag_contact", params: { contactId: "k1", tags: ["vip"] }, reason: "a" },
      { tool: "update_crm", params: {}, reason: "b" },
    ]);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/cannot be carried out: update_crm/) });
    expect(H.updates).toEqual([]);
    expect(H.calls).toEqual([]);
  });

  it("an unapproved plan runs nothing", async () => {
    const r = await run("propose_plan", { steps: [{ tool: "close_conversation", params: { conversationId: "c1" } }] }, { approved: false });
    expect(r.ok).toBe(false);
    expect(H.calls).toEqual([]);
  });
});
