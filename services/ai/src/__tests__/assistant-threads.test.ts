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
      user: { findUnique: async () => ({ name: "Omer", email: "o@x", role: "ADMIN", locale: null }) },
      tenant: { findUnique: async () => ({ name: "Lumiere", defaultLocale: "en" }) },
      conversation: t, message: t, contact: t, tenantTool: t, approvalRequest: t, aIAgent: t,
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
    generateResponse: async () => { H.titleCalls++; return { content: H.titleReply, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }; },
  };
});

import router from "../routes/assistant-threads";
import { SuggestionsSplitter, scopeDates } from "../services/assistant-threads.service";

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
  H.aiAllowed = true; H.user = "u1"; H.titleReply = "Refund questions"; H.n = 0; H.titleCalls = 0;
});

describe("threads", () => {
  it("create with the default scope; an invalid scope is 400", async () => {
    const t = await newThread();
    expect(t.scope).toEqual({ range: "last_7", channels: "all" });
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
    H.script = [tool("system_count_conversations", { status: "OPEN" }), say("There are ", "4 open. [[sugg", "estions]] [\"Which are waiting?\", \"Show last week\"]")];
    const r = await send(t.id, "how many open?");
    expect(r.status).toBe(200);
    const names = r.events.map((e) => e.event);
    expect(names).toEqual(["run.start", "step.start", "step.done", "text.delta", "text.delta", "suggestions", "thread.title", "message.done"]);
    const runId = r.events[0]!.data.runId;
    expect(r.events.map((e) => e.id)).toEqual(names.map((_, i) => `${runId}:${i + 1}`));
    const text = r.events.filter((e) => e.event === "text.delta").map((e) => e.data.text).join("");
    expect(text).toBe("There are 4 open. ");
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
    const t = await newThread();
    for (let i = 0; i < 10; i++) { H.script = [say("ok")]; expect((await send(t.id, `q${i}`)).status).toBe(200); }
    const r = await request(app()).post(`/api/assistant/threads/${t.id}/messages`).send({ text: "one more" });
    expect(r.status).toBe(429);
    expect(r.body.code).toBe("RATE_LIMITED");
    expect(r.body.retryAfterSeconds).toBeGreaterThan(0);
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
