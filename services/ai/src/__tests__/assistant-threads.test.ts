/**
 * ★ Home chat threads (docs/api/assistant-threads-v1.md), through the real
 * routes and the real assistant runtime with a scripted model:
 *   - threads: create (default scope), invalid scope, list newest first with a
 *     cursor, archive; another user's thread is 404 on every route
 *   - an answer streams run.start, steps, text, suggestions, thread.title,
 *     message.done, every event with an increasing `<runId>:<seq>` id; the
 *     suggestions block never shows in the text; the message is saved
 *   - the model gets the thread's scope and runs in the thread's own memory
 *   - one answer at a time (409), 10 a minute (429), billing refusal (402)
 *   - cancel really stops the model call; the text so far is kept
 *   - resume replays after Last-Event-ID; an expired run is 410
 *   - the token budget ends an answer with BUDGET_EXCEEDED
 *   - a user-set title is never overwritten; delete removes the memory too
 *   - ★ a turn is written in its question's language (steps, cards, sources,
 *     suggestions, the title, the full list), whatever the interface's
 *   - ★ the same query twice in one answer: one step, one card, one source
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({
  threads: [] as any[], messages: [] as any[], memoryDeletes: [] as any[], memoryAppends: [] as any[],
  kv: new Map<string, any>(),
  script: [] as Array<(p: any) => AsyncGenerator<any>>,
  modelCalls: [] as any[],
  aiAllowed: true,
  user: "u1",
  titleReply: "Refund questions",
  titleCalls: 0,
  titleAsks: [] as string[],
  convs: [] as any[],
  approvals: [] as any[],
  // Conversations a plan step can name (visibleConversation); empty keeps findFirst null for every other test.
  planConvs: [] as any[],
  n: 0,
}));

// ─── Redis double (the commands the run store uses) ─────────
vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const kv = H.kv;
  const redis = {
    rpush: async (k: string, v: string) => { const l = kv.get(k) ?? []; l.push(v); kv.set(k, l); return l.length; },
    lrange: async (k: string, a: number, b: number) => { const l = kv.get(k) ?? []; return l.slice(a, b === -1 ? undefined : b + 1); },
    llen: async (k: string) => (kv.get(k) ?? []).length,
    set: async (k: string, v: string, ...args: any[]) => { if (args.includes("NX") && kv.has(k)) return null; kv.set(k, v); return "OK"; },
    get: async (k: string) => kv.get(k) ?? null,
    del: async (k: string) => { kv.delete(k); return 1; },
    hset: async (k: string, a: any, b?: any) => { const h = kv.get(k) ?? {}; if (typeof a === "string") h[a] = b; else Object.assign(h, a); kv.set(k, h); return 1; },
    hgetall: async (k: string) => kv.get(k) ?? {},
    expire: async () => 1,
    incr: async (k: string) => { const n = (kv.get(k) ?? 0) + 1; kv.set(k, n); return n; },
  };
  const match = (row: any, where: any): boolean => Object.entries(where ?? {}).every(([k, v]: [string, any]) => {
    if (k === "AND") return v.every((w: any) => match(row, w));
    if (k === "OR") return v.some((w: any) => match(row, w));
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("not" in v) return row[k] !== v.not;
      if ("lt" in v) return row[k] < v.lt;
      return true;
    }
    return (row[k] ?? null) === v;
  });
  const t = { findFirst: async () => null, findMany: async () => [], findUnique: async () => null, count: async () => 4 };
  return {
    ...actual,
    getRedis: () => redis,
    createApprovalRequest: async () => ({ id: "apr_1" }),
    assertAiAllowed: async () => { if (!H.aiAllowed) { const e: any = new Error("no units"); e.name = "AiUnitsExhaustedError"; e.reason = "AI_UNITS_EXHAUSTED"; throw e; } return { allowed: true }; },
    authenticate: (req: any, _r: any, next: any) => { req.user = { userId: H.user, role: "ADMIN", tenantId: "T" }; req.tenantId = "T"; next(); },
    resolveTenant: (_q: any, _r: any, next: any) => next(),
    requireActiveTenant: () => (_q: any, _r: any, next: any) => next(),
    requirePermissionOrRole: () => (_q: any, _r: any, next: any) => next(),
    viewerOf: () => ({ userId: H.user, role: "ADMIN" }),
    prisma: {
      inboundExclusion: { findMany: async () => [] },
      assistantThread: {
        create: async (a: any) => { const r = { id: `thr_${++H.n}`, title: null, titleSource: null, createdAt: new Date(), updatedAt: new Date(Date.now() + H.n), lastMessageAt: null, archivedAt: null, ...a.data }; H.threads.push(r); return r; },
        findFirst: async (a: any) => H.threads.find((r) => match(r, a.where)) ?? null,
        findMany: async (a: any) => H.threads.filter((r) => match(r, a.where)).sort((x, y) => y.updatedAt - x.updatedAt || (y.id > x.id ? 1 : -1)).slice(0, a.take),
        update: async (a: any) => { const r = H.threads.find((x) => x.id === a.where.id); Object.assign(r, a.data, { updatedAt: new Date(Date.now() + ++H.n) }); return r; },
        updateMany: async (a: any) => { const rs = H.threads.filter((r) => match(r, a.where)); rs.forEach((r) => Object.assign(r, a.data)); return { count: rs.length }; },
        delete: async (a: any) => { H.threads = H.threads.filter((x) => x.id !== a.where.id); H.messages = H.messages.filter((m) => m.threadId !== a.where.id); return {}; },
      },
      assistantMessage: {
        create: async (a: any) => { const r = { id: `msg_${++H.n}`, steps: [], suggestions: [], ...a.data }; H.messages.push(r); return r; },
        update: async (a: any) => { const r = H.messages.find((x) => x.id === a.where.id); Object.assign(r, a.data); return r; },
        findFirst: async (a: any) => H.messages.find((r) => match(r, a.where)) ?? null,
        findMany: async (a: any) => H.messages.filter((r) => match(r, a.where)),
      },
      systemAgentMessage: { deleteMany: async (a: any) => { H.memoryDeletes.push(a.where); return { count: 1 }; } },
      user: { findUnique: async () => ({ name: "Omer", email: "o@x", role: "ADMIN", locale: null }), findFirst: async () => ({ name: "Omer", email: "o@x" }) },
      tenant: { findUnique: async () => ({ name: "Lumiere", defaultLocale: "en" }) },
      conversation: { ...t, findMany: async (a: any) => H.convs.slice(0, a.take ?? 1e9), findFirst: async (a: any) => H.planConvs.find((c) => c.id === a.where?.id && c.tenantId === a.where?.tenantId) ?? null }, message: t, contact: t, tenantTool: t, aIAgent: t,
      approvalRequest: { ...t, findFirst: async (a: any) => H.approvals.find((r) => r.id === a.where.id && r.tenantId === a.where.tenantId) ?? null },
    },
  };
});
vi.mock("../services/agent-memory.service", () => ({
  appendToMemory: async (a: any) => { H.memoryAppends.push(a); },
  getSessionMemory: async () => [],
  memoryToChatMessages: () => [],
  sanitizeHistoryForLLM: (x: any) => x,
}));
vi.mock("../services/ai.service", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    streamResponse: (p: any) => { H.modelCalls.push(p); const next = H.script.shift(); return next ? next(p) : (async function* () { yield { done: true, content: "", toolCalls: [], usage: {} }; })(); },
    generateResponse: async (p: any) => { H.titleCalls++; H.titleAsks.push(p.messages[0].content); return { content: H.titleReply, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }; },
  };
});

import router from "../routes/assistant-threads";
import { SuggestionsSplitter, scopeDates, withValidCitations, CitationFilter, usableTitle, titleFromQuestion, threadSystemLines } from "../services/assistant-threads.service";

const app = () => { const a = express(); a.use(express.json()); a.use("/api/assistant", router); return a; };
const sse = (r: request.Test) => r.buffer(true).parse((res, cb) => { let d = ""; res.on("data", (c: Buffer) => { d += c.toString(); }); res.on("end", () => cb(null, d)); });
function events(body: string) {
  return body.split("\n\n").filter((b) => b.startsWith("id:")).map((b) => {
    const id = /^id: (.*)$/m.exec(b)![1]!; const event = /^event: (.*)$/m.exec(b)![1]!; const data = JSON.parse(/^data: (.*)$/m.exec(b)![1]!);
    return { id, event, data };
  });
}
const tool = (name: string, args: any = {}) => async function* () { yield { done: true, content: "", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }, toolCalls: [{ id: `tc_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }; };
const say = (...deltas: string[]) => async function* () { for (const d of deltas) yield { contentDelta: d }; yield { done: true, content: deltas.join(""), toolCalls: [], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }; };

async function newThread(body: any = {}) { return (await request(app()).post("/api/assistant/threads").send(body)).body.data; }
async function send(threadId: string, text: string, extra: any = {}) {
  const r = await sse(request(app()).post(`/api/assistant/threads/${threadId}/messages`).send({ text, ...extra }));
  return { status: r.status, events: r.status === 200 ? events(r.body) : [], body: r.body };
}

beforeEach(() => {
  H.threads = []; H.messages = []; H.memoryDeletes = []; H.memoryAppends = []; H.kv.clear(); H.script = []; H.modelCalls = [];
  H.aiAllowed = true; H.user = "u1"; H.titleReply = "Refund questions"; H.n = 0; H.titleCalls = 0; H.titleAsks = [];
  H.convs = []; H.planConvs = [];
  H.approvals = [{ id: "apr_1", tenantId: "T", conversationId: null, tool: "propose_plan", summary: "לשייך ל-Dana את השיחה של Omer Serruya (וואטסאפ)", params: { steps: [{ target: { assigneeId: "u1" }, summary: "לשייך ל-Dana את השיחה של Omer Serruya (וואטסאפ)", summaryForAssignee: "לשייך אליך את השיחה של Omer Serruya (וואטסאפ)" }] } }, { id: "apr_other", tenantId: "OTHER", conversationId: null, summary: "x" }];
});
const openConv = (id: string, channel = "WHATSAPP") => ({ id, channel, status: "OPEN", handledBy: "ai_agent", isHandedOver: false, customerName: `Customer ${id}`, customerExternalId: id, createdAt: new Date(), lastMessageAt: new Date() });
/** One model turn asking for several tools at once. */
const tools = (...calls: Array<[string, any]>) => async function* () {
  yield { done: true, content: "", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }, toolCalls: calls.map(([name, args], i) => ({ id: `tc_${i}_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } })) };
};

describe("threads", () => {
  it("create with the default scope; an invalid scope is 400", async () => {
    const t = await newThread();
    expect(t.scope).toEqual({ range: "last_7", channels: "all" });
    // The resolved dates the assistant uses (last_7 = today and the six days before).
    const today = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);
    expect(t.scopeDates).toEqual({ from, to: today });
    expect(t.title).toBeNull();
    for (const scope of [{ range: "yesterday" }, { channels: ["FAX"] }, { range: { custom: { from: "2026-10-07", to: "2026-10-01" } } }, { channels: [] }]) {
      const r = await request(app()).post("/api/assistant/threads").send({ scope });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe("INVALID_SCOPE");
    }
  });

  it("list: newest first, a cursor pages, archived ones only with ?archived=1", async () => {
    const a = await newThread(); const b = await newThread(); const c = await newThread();
    await request(app()).patch(`/api/assistant/threads/${b.id}`).send({ archived: true });
    const p1 = (await request(app()).get("/api/assistant/threads?limit=1")).body;
    expect(p1.data.map((x: any) => x.id)).toEqual([c.id]);
    const p2 = (await request(app()).get(`/api/assistant/threads?limit=1&cursor=${p1.nextCursor}`)).body;
    expect(p2.data.map((x: any) => x.id)).toEqual([a.id]);
    expect(p2.nextCursor).toBeNull();
    expect((await request(app()).get("/api/assistant/threads?archived=1")).body.data.map((x: any) => x.id)).toEqual([b.id]);
  });

  it("★ another user's thread is 404 on every route", async () => {
    const t = await newThread();
    H.user = "u2";
    expect((await request(app()).get(`/api/assistant/threads/${t.id}`)).status).toBe(404);
    expect((await request(app()).patch(`/api/assistant/threads/${t.id}`).send({ title: "mine" })).status).toBe(404);
    expect((await request(app()).delete(`/api/assistant/threads/${t.id}`)).status).toBe(404);
    expect((await request(app()).post(`/api/assistant/threads/${t.id}/messages`).send({ text: "hi" })).status).toBe(404);
    expect((await request(app()).post(`/api/assistant/threads/${t.id}/messages/m/cancel`)).status).toBe(404);
    expect((await request(app()).get(`/api/assistant/threads/${t.id}/runs/r/events`)).status).toBe(404);
    expect((await request(app()).get("/api/assistant/threads")).body.data).toEqual([]);
    expect(H.threads[0].title).toBeNull();
    expect(H.modelCalls).toHaveLength(0);
  });

  it("title: 1-120 chars", async () => {
    const t = await newThread();
    expect((await request(app()).patch(`/api/assistant/threads/${t.id}`).send({ title: "x".repeat(121) })).body.code).toBe("TITLE_TOO_LONG");
    expect((await request(app()).patch(`/api/assistant/threads/${t.id}`).send({ title: "  " })).status).toBe(400);
  });
});

describe("★ an answer", () => {
  it("streams the events in order with increasing ids, and saves the message", async () => {
    const t = await newThread({ scope: { range: "last_30", channels: ["WHATSAPP"] } });
    H.script = [tool("system_count_conversations", { status: "OPEN" }), say("There are ", "4 open. [[sugg", "estions]] [{\"text\": \"Which are waiting?\", \"tool\": \"system_get_metric\"}, {\"text\": \"Show last week\", \"tool\": \"system_query_conversations\"}]")];
    const r = await send(t.id, "how many open?");
    expect(r.status).toBe(200);
    const names = r.events.map((e) => e.event);
    expect(names).toEqual(["run.start", "step.start", "step.done", "text.delta", "text.delta", "suggestions", "thread.title", "message.done"]);
    const runId = r.events[0]!.data.runId;
    expect(r.events.map((e) => e.id)).toEqual(names.map((_, i) => `${runId}:${i + 1}`));
    const text = r.events.filter((e) => e.event === "text.delta").map((e) => e.data.text).join("");
    // The space before the suggestions block is held (it could precede a citation) and never shown.
    expect(text).toBe("There are 4 open.");
    expect(r.events[2]!.data).toMatchObject({ status: "done" });
    expect(r.events[1]!.data.text).not.toMatch(/system_/);
    expect(r.events[5]!.data.items).toEqual(["Which are waiting?", "Show last week"]);
    expect(r.events[6]!.data.title).toBe("Refund questions");
    expect(r.events[7]!.data).toMatchObject({ messageId: r.events[0]!.data.messageId, status: "done" });

    const saved = H.messages.find((m) => m.id === r.events[0]!.data.messageId);
    expect(saved).toMatchObject({ role: "assistant", status: "done", text: "There are 4 open.", suggestions: ["Which are waiting?", "Show last week"], scope: { range: "last_30", channels: ["WHATSAPP"] }, runId });
    expect(saved.steps[0]).toMatchObject({ id: "tc_system_count_conversations", status: "done" });
    expect(H.messages.find((m) => m.id === r.events[0]!.data.userMessageId)).toMatchObject({ role: "user", text: "how many open?", status: "done" });
    expect(H.threads[0]).toMatchObject({ title: "Refund questions", titleSource: "auto" });

    // The thread's own memory and its scope reach the model.
    expect(H.memoryAppends.every((m) => m.sessionId === t.id)).toBe(true);
    const sys = H.modelCalls[0].messages.filter((m: any) => m.role === "system").map((m: any) => m.content).join("\n");
    const { from } = scopeDates({ range: "last_30", channels: ["WHATSAPP"] });
    expect(sys).toContain(`sinceISO=${from}T00:00:00.000Z`);
    // ★ The period is for activity over time, never for "open now" / "waiting for us".
    expect(sys).toMatch(/Never apply the period to the current state/);
    expect(sys).toContain("WHATSAPP");
    expect(sys).toContain("[[suggestions]]");

    // The screen's view.
    const v = (await request(app()).get(`/api/assistant/threads/${t.id}`)).body.data;
    expect(v.activeRun).toBeNull();
    expect(v.messages.map((m: any) => m.role)).toEqual(["user", "assistant"]);
    expect(v.messages[1]).toMatchObject({ blocks: [], sources: [], actions: [], status: "done" });
  });

  it("a Hebrew interface: suggestions asked for in Hebrew, step labels in Hebrew", async () => {
    const t = await newThread();
    H.script = [tool("system_get_metric", { metric: "closed_today" }), say("נסגרו 4.")];
    const r = await send(t.id, "כמה נסגרו היום?", { locale: "he" });
    expect(r.events.find((e) => e.event === "step.start")!.data.text).toMatch(/[֐-׿]/);
    expect(H.modelCalls[0].messages.some((m: any) => m.role === "system" && /written in Hebrew/.test(m.content))).toBe(true);
  });

  it("★ a title the user set is never overwritten", async () => {
    const t = await newThread();
    await request(app()).patch(`/api/assistant/threads/${t.id}`).send({ title: "My title" });
    H.script = [say("ok")];
    const r = await send(t.id, "hi");
    expect(r.events.map((e) => e.event)).not.toContain("thread.title");
    expect(H.threads[0].title).toBe("My title");
  });

  it("a failed tool is a failed step; a proposed plan is a waiting_approval step with its approval", async () => {
    const t = await newThread();
    H.script = [
      tool("system_get_metric", { metric: "waiting_for_person" }),
      tool("propose_plan", { summary: "Follow up", steps: [{ tool: "send_message", params: {}, reason: "follow up" }] }),
      say("I proposed a plan."),
    ];
    const r = await send(t.id, "follow up with everyone waiting");
    const done = r.events.filter((e) => e.event === "step.done").map((e) => e.data);
    expect(done[0]).toMatchObject({ status: "failed" });
    expect(done[1]).toMatchObject({ status: "waiting_approval", approvalRequestId: "apr_1" });
    const saved = H.messages.find((m) => m.role === "assistant");
    expect(saved.steps.map((x: any) => x.status)).toEqual(["failed", "waiting_approval"]);
    expect(saved.steps[1].approvalRequestId).toBe("apr_1");
  });

  it("text that only looked like the marker is kept, even at the very end", async () => {
    const t = await newThread();
    H.script = [say("See the list [", "[")];
    const r = await send(t.id, "hi");
    expect(r.events.filter((e) => e.event === "text.delta").map((e) => e.data.text).join("")).toBe("See the list [[");
  });

  it("★ only the first answer names the thread (one title call)", async () => {
    const t = await newThread();
    H.script = [say("one")];
    await send(t.id, "first");
    H.script = [say("two")];
    const r = await send(t.id, "second");
    expect(r.events.map((e) => e.event)).not.toContain("thread.title");
    expect(H.titleCalls).toBe(1);
  });

  it("★ a title the user sets while the first answer is being written wins", async () => {
    const t = await newThread();
    let release!: () => void;
    const gate = new Promise<void>((ok) => { release = ok; });
    H.script = [async function* () { yield { contentDelta: "thinking" }; await gate; yield { done: true, content: "thinking", toolCalls: [], usage: {} }; }];
    const pending = send(t.id, "first");
    for (let i = 0; i < 100 && !H.messages.some((m) => m.role === "assistant"); i++) await new Promise((ok) => setTimeout(ok, 10));
    expect((await request(app()).patch(`/api/assistant/threads/${t.id}`).send({ title: "Mine" })).status).toBe(200);
    release();
    const r = await pending;
    expect(r.events.map((e) => e.event)).not.toContain("thread.title");
    expect(H.threads[0]).toMatchObject({ title: "Mine", titleSource: "user" });
  });

  it("validation: empty and too long text", async () => {
    const t = await newThread();
    expect((await request(app()).post(`/api/assistant/threads/${t.id}/messages`).send({ text: " " })).body.code).toBe("TEXT_REQUIRED");
    const long = await request(app()).post(`/api/assistant/threads/${t.id}/messages`).send({ text: "x".repeat(4001) });
    expect(long.body).toMatchObject({ code: "TEXT_TOO_LONG", max: 4000 });
  });
});

describe("★ limits", () => {
  it("one answer at a time per thread: 409", async () => {
    const t = await newThread();
    H.kv.set(`assistant:thread:${t.id}:active`, "run_busy");
    const r = await request(app()).post(`/api/assistant/threads/${t.id}/messages`).send({ text: "hi" });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("RUN_IN_PROGRESS");
    expect(H.messages).toEqual([]);
  });

  it("more than 10 messages a minute: 429 with retryAfterSeconds", async () => {
    // One fixed minute: under load the ten sends could cross a minute boundary.
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 9, 7, 12, 0, 30));
    try {
      const t = await newThread();
      for (let i = 0; i < 10; i++) { H.script = [say("ok")]; expect((await send(t.id, `q${i}`)).status).toBe(200); }
      const r = await request(app()).post(`/api/assistant/threads/${t.id}/messages`).send({ text: "one more" });
      expect(r.status).toBe(429);
      expect(r.body.code).toBe("RATE_LIMITED");
      expect(r.body.retryAfterSeconds).toBe(30);
    } finally { clock.mockRestore(); }
  });

  it("billing refuses before any model call: 402", async () => {
    const t = await newThread();
    H.aiAllowed = false;
    const r = await request(app()).post(`/api/assistant/threads/${t.id}/messages`).send({ text: "hi" });
    expect(r.status).toBe(402);
    expect(H.modelCalls).toHaveLength(0);
    expect(H.messages).toEqual([]);
  });

  it("the token budget ends the answer with BUDGET_EXCEEDED", async () => {
    process.env.ASSISTANT_RUN_TOKEN_BUDGET = "2000";
    try {
      const t = await newThread();
      H.script = [async function* () { yield { done: true, content: "", usage: { input_tokens: 2500, output_tokens: 10, total_tokens: 2510 }, toolCalls: [{ id: "tc1", type: "function", function: { name: "system_count_conversations", arguments: "{}" } }] }; }];
      const r = await send(t.id, "count everything");
      const err = r.events.find((e) => e.event === "error");
      expect(err?.data.code).toBe("BUDGET_EXCEEDED");
      expect(r.events.at(-1)).toMatchObject({ event: "message.done", data: { status: "failed" } });
      expect(H.modelCalls).toHaveLength(1);
    } finally { delete process.env.ASSISTANT_RUN_TOKEN_BUDGET; }
  });
});

describe("★ cancel and resume", () => {
  it("cancel stops the model call; the text so far is kept", async () => {
    const t = await newThread();
    let sawAbort = false;
    H.script = [async function* (p: any) {
      yield { contentDelta: "Partial answer" };
      await new Promise<void>((ok) => { p.signal.addEventListener("abort", () => { sawAbort = true; ok(); }); });
      throw Object.assign(new Error("aborted"), { name: "APIUserAbortError" });
    }];
    const pending = send(t.id, "long question");
    let msg: any;
    for (let i = 0; i < 100 && !(msg = H.messages.find((m) => m.role === "assistant")); i++) await new Promise((ok) => setTimeout(ok, 10));
    await new Promise((ok) => setTimeout(ok, 50));
    const c = await request(app()).post(`/api/assistant/threads/${t.id}/messages/${msg.id}/cancel`);
    expect(c.status).toBe(202);
    const r = await pending;
    expect(sawAbort).toBe(true);
    expect(r.events.at(-1)).toMatchObject({ event: "message.done", data: { status: "cancelled" } });
    expect(r.events.map((e) => e.event)).not.toContain("error");
    expect(msg).toMatchObject({ status: "cancelled", text: "Partial answer" });
    // Cancelling a finished message just answers its status.
    expect((await request(app()).post(`/api/assistant/threads/${t.id}/messages/${msg.id}/cancel`)).body.data.status).toBe("cancelled");
    // The thread is free again.
    H.script = [say("next")];
    expect((await send(t.id, "again")).status).toBe(200);
  });

  it("resume replays only what came after Last-Event-ID; an expired run is 410", async () => {
    const t = await newThread();
    H.script = [say("one ", "two")];
    const first = await send(t.id, "hi");
    const runId = first.events[0]!.data.runId;
    const r = await sse(request(app()).get(`/api/assistant/threads/${t.id}/runs/${runId}/events`).set("Last-Event-ID", `${runId}:2`));
    const replay = events(r.body);
    expect(replay.map((e) => e.id)).toEqual(first.events.slice(2).map((e) => e.id));
    const q = events((await sse(request(app()).get(`/api/assistant/threads/${t.id}/runs/${runId}/events?after=${first.events.length - 1}`))).body);
    expect(q.map((e) => e.event)).toEqual(["message.done"]);
    H.kv.delete(`assistant:run:${runId}:meta`);
    expect((await request(app()).get(`/api/assistant/threads/${t.id}/runs/${runId}/events`)).status).toBe(410);
  });

  it("a reload mid-answer gets activeRun; a dead run's message reads failed", async () => {
    const t = await newThread();
    H.messages.push({ id: "m_dead", threadId: t.id, role: "assistant", text: "half", status: "streaming", steps: [], suggestions: [], createdAt: new Date(0) });
    const v = (await request(app()).get(`/api/assistant/threads/${t.id}`)).body.data;
    expect(v.activeRun).toBeNull();
    expect(v.messages[0].status).toBe("failed");
    H.kv.set(`assistant:thread:${t.id}:active`, "run_live");
    H.kv.set("assistant:run:run_live:meta", { threadId: t.id, messageId: "m_dead" });
    H.kv.set("assistant:run:run_live:events", ["{}", "{}", "{}"]);
    const v2 = (await request(app()).get(`/api/assistant/threads/${t.id}`)).body.data;
    expect(v2.activeRun).toEqual({ runId: "run_live", messageId: "m_dead", lastEventId: "run_live:3" });
    expect(v2.messages[0].status).toBe("streaming");
  });
});

describe("★ stage 2: cards and sources from the server, never the model", () => {
  it("a query becomes a block event and a source; an invented citation is dropped; both are saved and returned", async () => {
    const t = await newThread();
    H.convs = [openConv("c1")];
    H.script = [tool("system_query_conversations", { groupBy: "day" }), say("Quiet week [^s1], busier than [^s9].")];
    const r = await send(t.id, "how was the week?");
    const names = r.events.map((e) => e.event);
    expect(names.indexOf("block")).toBeGreaterThan(names.indexOf("step.start"));
    expect(names.indexOf("sources")).toBeGreaterThan(names.lastIndexOf("text.delta"));
    expect(names.indexOf("sources")).toBeLessThan(names.indexOf("message.done"));
    const block = r.events.find((e) => e.event === "block")!.data.block;
    expect(block).toMatchObject({ type: "chart", id: "b1", sourceId: "s1" });
    const sources = r.events.find((e) => e.event === "sources")!.data.items;
    expect(sources.map((x: any) => x.id)).toEqual(["s1"]);
    expect(sources[0].query.tool).toBe("conversations");
    const saved = H.messages.find((m) => m.role === "assistant");
    // A dropped citation takes its space with it.
    expect(saved.text).toBe("Quiet week [^s1], busier than.");
    expect(saved.blocks).toHaveLength(1);
    expect(saved.sources.map((x: any) => x.id)).toEqual(["s1"]);
    const v = (await request(app()).get(`/api/assistant/threads/${t.id}`)).body.data;
    expect(v.messages[1].blocks[0]).toMatchObject({ type: "chart", id: "b1" });
    expect(v.messages[1].sources[0].id).toBe("s1");
  });

  it("the full list behind a source: re-run for the owner; another source or another user is 404", async () => {
    const t = await newThread();
    H.script = [tool("system_query_conversations", { mention: "small" }), say("ok [^s1]")];
    await send(t.id, "who said small?");
    const mid = H.messages.find((m) => m.role === "assistant").id;
    const ok = await request(app()).get(`/api/assistant/threads/${t.id}/messages/${mid}/sources/s1/records`);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ data: [], nextCursor: null });
    expect((await request(app()).get(`/api/assistant/threads/${t.id}/messages/${mid}/sources/s7/records`)).status).toBe(404);
    H.user = "u2";
    expect((await request(app()).get(`/api/assistant/threads/${t.id}/messages/${mid}/sources/s1/records`)).status).toBe(404);
  });
});

describe("delete", () => {
  it("removes the thread, its messages and its memory, and cancels a running answer", async () => {
    const t = await newThread();
    H.script = [say("ok")];
    await send(t.id, "hi");
    H.kv.set(`assistant:thread:${t.id}:active`, "run_x");
    H.kv.set("assistant:run:run_x:meta", { threadId: t.id, messageId: "m" });
    expect((await request(app()).delete(`/api/assistant/threads/${t.id}`)).status).toBe(204);
    expect(H.threads).toEqual([]);
    expect(H.messages).toEqual([]);
    expect(H.memoryDeletes).toEqual([{ tenantId: "T", userId: "u1", sessionId: t.id }]);
    expect(H.kv.get("assistant:run:run_x:cancel")).toBe("1");
  });
});

describe("the suggestions block never reaches the screen", () => {
  it("a marker split across deltas is held back; a false alarm is released", () => {
    const s = new SuggestionsSplitter();
    const out = ["Hello [", "[sug", "gestions]", "] [\"a?\",\"b?\"]"].map((d) => s.push(d)).join("");
    expect(out).toBe("Hello ");
    expect(s.end()).toEqual({ rest: "", suggestions: ["a?", "b?"] });
    const f = new SuggestionsSplitter();
    const o2 = ["see [[", "link]] now"].map((d) => f.push(d)).join("");
    expect(o2 + f.end().rest).toBe("see [[link]] now");
  });
});

describe("★ a turn speaks its question's language (Omer, 2026-10-08)", () => {
  it("a Hebrew question on an English screen: steps, cards, sources, suggestions and the title in Hebrew", async () => {
    const t = await newThread();
    H.convs = [openConv("c1"), openConv("c2", "SHOPIFY_LIVE_CHAT")];
    H.script = [tool("system_query_conversations", { now: true, status: "OPEN", groupBy: "channel" }), say("2 [^s1]")];
    const r = await send(t.id, "מגניב, כמה מהם מוואטסאפ ?", { locale: "en" });
    expect(r.events.find((e) => e.event === "step.start")!.data.text).toBe("בודקת את השיחות");
    const block = r.events.find((e) => e.event === "block")!.data.block;
    expect(block.title).toBe("לפי ערוץ");
    expect(block.items.map((i: any) => i.label).sort()).toEqual(["וואטסאפ", "צ'אט Shopify"].sort());
    expect(r.events.find((e) => e.event === "sources")!.data.items[0].label).toBe("2 שיחות (פתוחות) · כרגע");
    expect(H.modelCalls[0].messages.some((m: any) => m.role === "system" && /written in Hebrew/.test(m.content))).toBe(true);
    expect(H.titleAsks[0]).toMatch(/in Hebrew/);
    // ★ What the model reads is in the turn's language too: it repeats it
    // ("בסך הכל right now" leaked from English prose in the result, 2026-10-08).
    const result = H.modelCalls[1].messages.find((m: any) => m.role === "tool").content;
    expect(JSON.parse(result)).toMatchObject({ period: "כרגע", cards: ["לפי ערוץ: פילוח ל-2 קבוצות"] });
    // Every value the model may repeat (all but the instruction): no English words, brand names aside.
    const { shownAs: _instruction, ...words } = JSON.parse(result);
    const texts: string[] = [];
    const collect = (v: unknown): void => { if (typeof v === "string") texts.push(v); else if (v && typeof v === "object") Object.values(v).forEach(collect); };
    collect(words);
    expect(texts.join(" | ").replace(/Shopify|\bs1\b/g, "")).not.toMatch(/[A-Za-z]{3,}/);
    // The turn's language for the answer's own chrome: live and saved.
    expect(r.events.find((e) => e.event === "run.start")!.data.lang).toBe("he");
    const view = (await request(app()).get(`/api/assistant/threads/${t.id}`)).body.data;
    expect(view.messages.map((m: any) => m.lang)).toEqual([undefined, "he"]);
    // The full list behind the card: the same language as the answer it belongs to.
    const mid = H.messages.find((m) => m.role === "assistant").id;
    const list = await request(app()).get(`/api/assistant/threads/${t.id}/messages/${mid}/sources/s1/records?locale=en`);
    expect(list.body.data[0].subtitle).toBe("וואטסאפ · פתוחה · GOTCHA");
  });

  it("an English question on a Hebrew screen is answered in English; a question with no language keeps the screen's", async () => {
    const t = await newThread();
    H.script = [tool("system_get_metric", { metric: "open_conversations" }), say("17.")];
    const r = await send(t.id, "how many are open? (כמה)", { locale: "he" });
    expect(r.events.find((e) => e.event === "step.start")!.data.text).toBe("Counting the open conversations");
    expect(H.titleAsks[0]).toMatch(/in English/);
    H.script = [tool("system_get_metric", { metric: "open_conversations" }), say("17.")];
    const n = await send(t.id, "17?", { locale: "he" });
    expect(n.events.find((e) => e.event === "step.start")!.data.text).toBe("סופרת את השיחות הפתוחות");
    expect(n.events.find((e) => e.event === "run.start")!.data.lang).toBe("he");
    // Saved: the English turn says en; the one without a language says nothing (the UI's stands).
    const view = (await request(app()).get(`/api/assistant/threads/${t.id}`)).body.data;
    expect(view.messages.filter((m: any) => m.role === "assistant").map((m: any) => m.lang ?? null)).toEqual(["en", null]);
  });
});

describe("★ one card per question (Omer, 2026-10-08: two identical 'By channel' cards)", () => {
  it("the same query twice in one answer runs once: one step, one card, one source; the model still gets an answer for each call", async () => {
    const t = await newThread();
    H.convs = [openConv("c1"), openConv("c2")];
    const q = { now: true, status: "OPEN", groupBy: "channel" };
    H.script = [
      tools(["system_query_conversations", q], ["system_query_conversations", { groupBy: "channel", status: "OPEN", now: true }]),
      // Next round: the same query with a default spelled out (other words, same rows).
      tools(["system_query_conversations", { ...q, channels: [] }]),
      say("2 [^s1]"),
    ];
    const r = await send(t.id, "how many of them on WhatsApp?");
    expect(r.events.filter((e) => e.event === "block")).toHaveLength(1);
    expect(r.events.find((e) => e.event === "sources")!.data.items.map((x: any) => x.id)).toEqual(["s1"]);
    // The repeat in the same round shows no step; the respelled one does (it ran), but drew nothing.
    expect(r.events.filter((e) => e.event === "step.start")).toHaveLength(2);
    const toolMsgs = H.modelCalls[2].messages.filter((m: any) => m.role === "tool");
    expect(toolMsgs).toHaveLength(3);
    expect(new Set(toolMsgs.map((m: any) => m.content)).size).toBe(1);
    expect(JSON.parse(toolMsgs[0].content).cite).toBe("s1");
    const saved = H.messages.find((m) => m.role === "assistant");
    expect(saved.blocks).toHaveLength(1);
    expect(saved.sources).toHaveLength(1);
  });

  it("an action is never skipped as a repeat", async () => {
    const t = await newThread();
    const plan = { summary: "Tag them", steps: [{ tool: "tag_contact", params: {}, reason: "x" }] };
    H.script = [tools(["propose_plan", plan], ["propose_plan", plan]), say("ok")];
    const r = await send(t.id, "tag them");
    expect(r.events.filter((e) => e.event === "step.start")).toHaveLength(2);
  });
});

describe("★ citations: only a source of this answer (2026-10-08: \"[^שיחות פתוחות...]\" on screen)", () => {
  const ids = new Set(["s1"]);
  const text = "יש 17 שיחות פתוחות [^s1], כולל אלה שה-AI עונה בהן [^שיחות פתוחות, כולל אלה שה-AI עונה בהן]. ועוד [^s9].";
  const clean = "יש 17 שיחות פתוחות [^s1], כולל אלה שה-AI עונה בהן. ועוד.";

  it("saved: free text and a source that is not there go, with the space before them; a real one stays", () => {
    expect(withValidCitations(text, ids)).toBe(clean);
    expect(withValidCitations("see [^S1] and [^s1x] and [^]", ids)).toBe("see and and");
  });

  it("streamed: a dropped marker never reaches the screen, however the tokens split", () => {
    for (const size of [1, 2, 3, 5, 8, 13]) {
      const f = new CitationFilter(() => ids);
      const shown: string[] = [];
      for (let i = 0; i < text.length; i += size) shown.push(f.push(text.slice(i, i + size)));
      shown.push(f.end());
      expect(shown.join("")).toBe(clean);
      expect(shown.some((x) => x.includes("[^ש") || x.includes("s9"))).toBe(false);
    }
    // Text that only looks like a start is released: a link, a lone bracket at the end.
    const f = new CitationFilter(() => ids);
    expect(f.push("a [link](/x) b [") + f.end()).toBe("a [link](/x) b [");
  });

  it("★ through the route: the open count has a source to cite; a free-text marker is never streamed or saved", async () => {
    const t = await newThread();
    H.script = [tool("system_get_metric", { metric: "open_conversations" }), say("יש 4 שיחות פתוחות [^s1], כולל אלה שה-AI עונה בהן [^שיחות פתוחות", ", כולל אלה שה-AI עונה בהן].")];
    const r = await send(t.id, "כמה שיחות פתוחות יש?", { locale: "en" });
    const streamed = r.events.filter((e) => e.event === "text.delta").map((e) => e.data.text).join("");
    expect(streamed).toBe("יש 4 שיחות פתוחות [^s1], כולל אלה שה-AI עונה בהן.");
    const sources = r.events.find((e) => e.event === "sources")!.data.items;
    expect(sources).toEqual([{ id: "s1", label: "4 שיחות (פתוחות) · כרגע", kind: "conversations", count: 4, deepLink: null, query: { tool: "conversations", params: { now: true, status: "OPEN" } } }]);
    expect(r.events.filter((e) => e.event === "block")).toHaveLength(0);
    expect(JSON.parse(H.modelCalls[1].messages.find((m: any) => m.role === "tool").content)).toMatchObject({ value: 4, cite: "s1" });
    expect(H.messages.find((m) => m.role === "assistant").text).toBe(streamed);
  });

  // The metric's source has no groupBy and a query's always has one: never "the same query".
  it("the open count and a split of the same rows are two answers: the split still draws its card", async () => {
    const t = await newThread();
    H.convs = [openConv("c1")];
    H.script = [
      tool("system_get_metric", { metric: "open_conversations" }),
      tool("system_query_conversations", { now: true, status: "OPEN" }),
      say("ok [^s1] [^s2]"),
    ];
    const r = await send(t.id, "how many open, by channel?");
    expect(r.events.filter((e) => e.event === "block")).toHaveLength(1);
    expect(r.events.find((e) => e.event === "sources")!.data.items.map((x: any) => x.id)).toEqual(["s1", "s2"]);
  });
});

describe("★ the thread's title (2026-10-08: \"מָהָם שִׁיחות עִכשִיוֹת\" for \"היי, כמה שיחות יש לנו ?\")", () => {
  it("through the route: a title with niqqud is stored without it; an invented one falls back to the question's words", async () => {
    const t = await newThread();
    H.titleReply = "שִׁיחות פְּתוּחות";
    H.script = [say("17.")];
    await send(t.id, "כמה שיחות פתוחות יש?", { locale: "en" });
    expect(H.threads.find((x) => x.id === t.id)).toMatchObject({ title: "שיחות פתוחות", titleSource: "auto" });
    // The title model is told: modern Hebrew without niqqud, 2 to 6 words, from the question.
    expect(H.titleAsks[0]).toMatch(/without niqqud/);
    expect(H.titleAsks[0]).toMatch(/2 to 6 words.*taken from the user's question/);

    const u = await newThread();
    H.titleReply = "מָהָם שִׁיחות עִכשִיוֹת";
    H.script = [say("17.")];
    await send(u.id, "היי, כמה שיחות יש לנו ?");
    expect(H.threads.find((x) => x.id === u.id)!.title).toBe("כמה שיחות יש לנו");
  });

  it("usable: in the turn's language, and with niqqud only when mostly from the question; a paraphrase is kept", () => {
    expect(usableTitle("Open conversations", "כמה שיחות פתוחות יש?", "he")).toBe("כמה שיחות פתוחות יש");
    expect(usableTitle("", "how was the week?", "en")).toBe("how was the week");
    expect(usableTitle("Weekly conversation trend", "how was the week?", "en")).toBe("Weekly conversation trend");
    expect(usableTitle("שיחות פתוחות עכשיו", "היי, כמה שיחות יש לנו ?", "he")).toBe("שיחות פתוחות עכשיו");
    // A one-letter prefix still counts as the question's word; the maqaf becomes a hyphen.
    expect(usableTitle("מֵהַשִּׂיחוֹת בְּוואטסאפ", "כמה מהשיחות בוואטסאפ?", "he")).toBe("מהשיחות בוואטסאפ");
    // "וואטסאפ" is the question's "בוואטסאפ" without its prefix: half the words, kept.
    expect(usableTitle("שִׂיחוֹת וואטסאפ", "כמה מהשיחות בוואטסאפ?", "he")).toBe("שיחות וואטסאפ");
    expect(usableTitle("שִׂיחוֹת ב\u05BEWhatsApp", "כמה שיחות ב-WhatsApp?", "he")).toBe("שיחות ב-WhatsApp");
  });

  it("from the question: no greeting, no final punctuation, at most 6 words", () => {
    expect(titleFromQuestion("היי, כמה שיחות יש לנו ?")).toBe("כמה שיחות יש לנו");
    expect(titleFromQuestion("Hello! how many open conversations do we have this week on WhatsApp?")).toBe("how many open conversations do we");
    expect(titleFromQuestion("  ?? ")).toBeNull();
  });
});

describe("★ suggestions only from tools (2026-10-08: 'List the 17 open conversations' with no tool to list)", () => {
  it("a follow-up survives only when it names a tool of this answer; none that needs a selection a Home thread lacks", async () => {
    const t = await newThread();
    H.script = [say("17 open.", ' [[suggestions]] [{"text": "List them", "tool": "system_list_conversations"}, {"text": "Export them to CSV", "tool": "system_export_csv"}, "Show the 2 WhatsApp ones", {"text": "Summarize the selected conversation", "tool": "system_summarize_conversation"}, {"text": "Find Omer", "tool": "system_find_customers"}]')];
    const r = await send(t.id, "how many open?");
    expect(r.events.find((e) => e.event === "suggestions")!.data.items).toEqual(["List them", "Find Omer"]);
    expect(H.messages.find((m) => m.role === "assistant").suggestions).toEqual(["List them", "Find Omer"]);
  });

  it("the model is asked for the tool of each follow-up", () => {
    const lines = threadSystemLines({ range: "last_7", channels: "all" }, "en").join("\n");
    expect(lines).toMatch(/"tool": the name of the ONE tool of yours that would answer it/);
  });

  it("★ an action follow-up names an action that can run, or it is dropped ('transfer it to a colleague', 2026-10-08)", () => {
    const s = new SuggestionsSplitter();
    s.push('ok [[suggestions]] [{"text": "Transfer it to a colleague", "tool": "propose_plan"}, {"text": "Refund him", "tool": "propose_plan", "action": "issue_refund"}, {"text": "Tag him VIP", "tool": "propose_plan", "action": "tag_contact"}]');
    expect(s.end({ tools: new Set(["propose_plan"]), noSelection: true }).suggestions).toEqual(["Tag him VIP"]);
    expect(threadSystemLines({ range: "last_7", channels: "all" }, "en").join("\\n")).toMatch(/"tool": "propose_plan", "action": one of send_message, tag_contact/);
  });

  it("the splitter: tools checked only when given", () => {
    const s = new SuggestionsSplitter();
    s.push('ok [[suggestions]] [{"text": "a?", "tool": "x"}, {"text": "b?", "tool": "y"}, "c?"]');
    expect(s.end({ tools: new Set(["x"]) }).suggestions).toEqual(["a?"]);
  });
});

describe("★ a thread about one request (design 03)", () => {
  it("created with the request: context on create, on the thread and in the list; a new period keeps it", async () => {
    const r = await request(app()).post("/api/assistant/threads").send({ context: { approvalId: "apr_1" } });
    expect(r.status).toBe(201);
    expect(r.body.data.context).toEqual({ approvalId: "apr_1" });
    const id = r.body.data.id;
    expect((await request(app()).get(`/api/assistant/threads/${id}`)).body.data.thread.context).toEqual({ approvalId: "apr_1" });
    expect((await request(app()).get("/api/assistant/threads")).body.data.find((x: any) => x.id === id).context).toEqual({ approvalId: "apr_1" });
    await request(app()).patch(`/api/assistant/threads/${id}`).send({ scope: { range: "last_30" } });
    expect((await request(app()).get(`/api/assistant/threads/${id}`)).body.data.thread).toMatchObject({ context: { approvalId: "apr_1" }, scope: { range: "last_30", channels: "all" } });
    // The model is told what this thread is about, and that it cannot decide it.
    H.script = [say("ok")];
    await send(id, "why does this need my approval?");
    const sys = H.modelCalls.at(-1).messages.filter((m: any) => m.role === "system").map((m: any) => m.content).join("\n");
    expect(sys).toMatch(/about one approval request. Read it with system_read_approval .* you cannot approve or reject it/);
  });

  it("★ never offers to propose the request again; a plain thread still may", async () => {
    const line = ' [[suggestions]] [{"text": "Propose assigning it to me", "tool": "propose_plan", "action": "assign_conversation"}, {"text": "Who asked?", "tool": "system_read_approval"}]';
    const about = (await request(app()).post("/api/assistant/threads").send({ context: { approvalId: "apr_1" } })).body.data.id;
    H.script = [say("ok", line)];
    const r = await send(about, "why does this need approval?");
    expect(r.events.find((e) => e.event === "suggestions")!.data.items).toEqual(["Who asked?"]);
    const plain = await newThread();
    H.script = [say("ok", line)];
    const p = await send(plain.id, "why does this need approval?");
    expect(p.events.find((e) => e.event === "suggestions")!.data.items).toContain("Propose assigning it to me");
  });

  it("the operator is never addressed in a gender (Hebrew)", async () => {
    const t = await newThread();
    H.script = [say("ok")];
    await send(t.id, "מה קורה?");
    const sys = H.modelCalls.at(-1).messages.filter((m: any) => m.role === "system").map((m: any) => m.content).join("\n");
    expect(sys).toMatch(/You do not know the operator's gender/);
    expect(sys).not.toMatch(/addressed as they write/);
  });

  it("★ named by its request on the server, with no model call; the first answer never renames it", async () => {
    const r = await request(app()).post("/api/assistant/threads").send({ context: { approvalId: "apr_1" }, locale: "he" });
    expect(r.body.data.title).toBe("על הבקשה: לשייך אליך את השיחה של Omer Serruya");
    // Stored as ours, not the user's: a rename by the user still wins.
    expect(H.threads.find((t: any) => t.id === r.body.data.id).titleSource).toBe("auto");
    H.script = [say("ok")];
    const turn = await send(r.body.data.id, "למה זה צריך אישור?");
    expect(turn.events.map((e) => e.event)).not.toContain("thread.title");
    // One model call: the answer. None for a title.
    expect(H.modelCalls).toHaveLength(1);
    expect((await request(app()).get(`/api/assistant/threads/${r.body.data.id}`)).body.data.thread.title).toBe("על הבקשה: לשייך אליך את השיחה של Omer Serruya");
    expect((await request(app()).post("/api/assistant/threads").send({ context: { approvalId: "apr_1" }, locale: "en" })).body.data.title).toBe("About the request: לשייך אליך את השיחה של Omer Serruya");
    // Named for its owner: someone who is not the assignee reads the assignee's name.
    H.user = "u2";
    expect((await request(app()).post("/api/assistant/threads").send({ context: { approvalId: "apr_1" }, locale: "he" })).body.data.title).toBe("על הבקשה: לשייך ל-Dana את השיחה של Omer Serruya");
  });

  it("another workspace's request, or none: 404 APPROVAL_NOT_FOUND, and no thread", async () => {
    for (const context of [{ approvalId: "apr_other" }, { approvalId: "nope" }, {}]) {
      const r = await request(app()).post("/api/assistant/threads").send({ context });
      expect(r.status).toBe(404);
      expect(r.body.code).toBe("APPROVAL_NOT_FOUND");
    }
    expect(H.threads).toEqual([]);
    // A plain thread has no context.
    expect((await request(app()).post("/api/assistant/threads").send({})).body.data.context).toBeNull();
  });
});

describe("★ proposed is not done (2026-10-08: \"שייכתי אליך את השיחה\" for a request that only waited)", () => {
  const plan = tool("propose_plan", { steps: [{ tool: "create_workflow", params: {}, reason: "x" }] });

  it("after a proposal, the answer is the server's sentence: the model's 'done' never streams nor is saved", async () => {
    const t = await newThread();
    H.script = [plan, say("יצרתי את האוטומציה ", "בשבילך. [[suggestions]] []")];
    const r = await send(t.id, "תיצרי אוטומציה");
    const streamed = r.events.filter((e) => e.event === "text.delta").map((e) => e.data.text).join("");
    expect(streamed).toBe("הכנתי בקשה ליצור אוטומציה. היא מחכה לאישור במסך האישורים.");
    expect(streamed).not.toMatch(/יצרתי/);
    expect(H.messages.find((m) => m.role === "assistant").text).toBe(streamed);
  });

  it("the title names the request, without a model call and without a 'done' verb; in English too", async () => {
    const t = await newThread();
    H.titleReply = "העברתי את השיחה";
    H.script = [plan, say("Done, I created it.")];
    const r = await send(t.id, "create an automation");
    expect(r.events.filter((e) => e.event === "text.delta").map((e) => e.data.text).join("")).toBe("I prepared a request to create an automation; it is waiting for approval on the Approvals screen.");
    expect(H.threads.find((x) => x.id === t.id).title).toBe("Request: Create an automation");
    expect(H.titleCalls).toBe(0);
  });
});

describe("★ a proposed plan is a proposal block (G5, 2026-10-09)", () => {
  const conv = { id: "c1", tenantId: "T", channel: "WHATSAPP", status: "OPEN", customerName: "Dana Levi", customerExternalId: "972500000001", channelAccountId: null };
  const plan = tool("propose_plan", { steps: [
    { tool: "claim_conversation", params: { conversationId: "c1" }, reason: "x" },
    { tool: "create_workflow", params: {}, reason: "y" },
  ] });
  const expected = {
    type: "proposal",
    approvalRequestId: "apr_1",
    // The owner is the assignee: plan-summary says it to them as "you".
    summary: "Assign Dana Levi's WhatsApp conversation to you; Create an automation",
    steps: [
      { summary: "Assign Dana Levi's WhatsApp conversation to you", target: { conversationId: "c1", assigneeId: "u1" } },
      { summary: "Create an automation", target: null },
    ],
    state: "pending",
  };
  const view = async (id: string) => (await request(app()).get(`/api/assistant/threads/${id}`)).body.data.messages.find((m: any) => m.role === "assistant");

  it("streams a `proposal` event and saves the block with the answer; the text stays for older clients", async () => {
    H.planConvs = [conv];
    const t = await newThread();
    H.script = [plan, say("Done, I assigned it.")];
    const r = await send(t.id, "assign Dana's conversation to me and make an automation");
    const ev = r.events.filter((e) => e.event === "proposal");
    expect(ev).toHaveLength(1);
    expect(ev[0]!.data).toEqual({ block: expected });
    // Before the answer ends, beside the waiting step that names the same request.
    const names = r.events.map((e) => e.event);
    expect(names.indexOf("proposal")).toBeLessThan(names.indexOf("message.done"));
    expect(names.indexOf("proposal")).toBeLessThan(names.indexOf("step.done"));
    expect(r.events.find((e) => e.event === "step.done")!.data).toMatchObject({ status: "waiting_approval", approvalRequestId: "apr_1" });
    expect(r.events.filter((e) => e.event === "text.delta").map((e) => e.data.text).join("")).toMatch(/^I prepared a request to assign Dana Levi/);
    const saved = H.messages.find((m) => m.role === "assistant");
    expect(saved.blocks).toEqual([expected]);
    // The fixture approval has no status: the saved state stands.
    expect((await view(t.id)).blocks).toEqual([expected]);
  });

  it("the state is the approval's own on every read; the saved row is not rewritten", async () => {
    H.planConvs = [conv];
    const t = await newThread();
    H.script = [plan, say("ok")];
    await send(t.id, "assign it to me");
    const future = new Date(Date.now() + 3_600_000), past = new Date(Date.now() - 1000);
    const cases: Array<[any, string]> = [
      [{ status: "PENDING", expiresAt: future }, "pending"],
      [{ status: "PENDING", expiresAt: past }, "expired"],
      [{ status: "APPROVED", executionState: "NOT_STARTED", expiresAt: past }, "approved"],
      [{ status: "APPROVED", executionState: "FAILED", expiresAt: past }, "approved"],
      [{ status: "APPROVED", executionState: "SUCCEEDED", expiresAt: past }, "executed"],
      [{ status: "REJECTED", expiresAt: future }, "rejected"],
      [{ status: "EXPIRED", expiresAt: past }, "expired"],
      [{ status: "CANCELLED", expiresAt: future }, "pending"],
    ];
    for (const [row, state] of cases) {
      H.approvals = [{ id: "apr_1", tenantId: "T", conversationId: null, tool: "propose_plan", summary: "x", params: {}, ...row }];
      const m = await view(t.id);
      expect([row.status, row.executionState, m.blocks[0].state]).toEqual([row.status, row.executionState, state]);
      expect(m.blocks[0].steps).toEqual(expected.steps);
    }
    expect(H.messages.find((m) => m.role === "assistant").blocks[0].state).toBe("pending");
  });

  it("matched by the tenant and read as the viewer may: another tenant's row or an unseen conversation leaves the saved state", async () => {
    H.planConvs = [conv];
    const t = await newThread();
    H.script = [plan, say("ok")];
    await send(t.id, "assign it to me");
    H.approvals = [{ id: "apr_1", tenantId: "OTHER", conversationId: null, tool: "propose_plan", summary: "x", params: {}, status: "REJECTED" }];
    expect((await view(t.id)).blocks[0].state).toBe("pending");
    // Tied to a conversation this viewer cannot see (not in H.planConvs any more).
    H.planConvs = [];
    H.approvals = [{ id: "apr_1", tenantId: "T", conversationId: "c1", tool: "propose_plan", summary: "x", params: {}, status: "REJECTED" }];
    expect((await view(t.id)).blocks[0].state).toBe("pending");
    H.planConvs = [conv];
    expect((await view(t.id)).blocks[0].state).toBe("rejected");
  });

  it("an answer without a proposal has no proposal block nor event", async () => {
    const t = await newThread();
    H.script = [say("hello")];
    const r = await send(t.id, "hi");
    expect(r.events.map((e) => e.event)).not.toContain("proposal");
    expect(H.messages.find((m) => m.role === "assistant").blocks).toEqual([]);
  });
});
