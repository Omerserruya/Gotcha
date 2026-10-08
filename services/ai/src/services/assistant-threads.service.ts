/**
 * Home chat threads (docs/api/assistant-threads-v1.md, stage 1).
 *
 * One engine: every answer is a run of the existing assistant runtime
 * (runAgent) with sessionId = the thread id, so the model's own memory (tool
 * calls included) stays in system_agent_messages; AssistantThread /
 * AssistantMessage hold what the screen shows.
 *
 * A run is detached from the request that started it: its events go to a
 * short-lived Redis list, and every stream (the first one, a reconnect, a
 * reload) tails that list. Closing the tab therefore never stops an answer;
 * only the cancel route does (a Redis flag the run polls, which aborts the
 * model call in flight).
 */
import crypto from "crypto";
import { prisma, getRedis, type Viewer } from "@chatcenter/shared";
import { runAgent, type AgentRuntimeEvent } from "./agent-runtime.service";
import { generateResponse, getMicroModel } from "./ai.service";
import { withoutWideDashes } from "../lib/wide-dash";
import { whenText } from "./system-tools.service";
import { questionLanguage } from "../lib/reader-locale";

// ─── Scope ──────────────────────────────────────────────────

export type ScopeRange = "this_week" | "last_7" | "last_30" | { custom: { from: string; to: string } };
export interface ThreadScope { range: ScopeRange; channels: "all" | string[] }

export const DEFAULT_SCOPE: ThreadScope = { range: "last_7", channels: "all" };
const RANGES = new Set(["this_week", "last_7", "last_30"]);
const CHANNELS = new Set(["WHATSAPP", "INSTAGRAM", "MESSENGER", "EMAIL", "GMAIL", "OUTLOOK", "SLACK", "VOICE", "WEBCHAT", "SHOPIFY_LIVE_CHAT", "SMS", "TELEGRAM"]);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A valid scope, the default for `undefined`, or null when invalid (400 INVALID_SCOPE). */
export function normalizeScope(raw: unknown): ThreadScope | null {
  if (raw === undefined || raw === null) return { ...DEFAULT_SCOPE };
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, any>;
  let range: ScopeRange;
  if (r.range === undefined) range = DEFAULT_SCOPE.range;
  else if (typeof r.range === "string" && RANGES.has(r.range)) range = r.range as ScopeRange;
  else if (r.range && typeof r.range === "object" && r.range.custom && DAY.test(String(r.range.custom.from)) && DAY.test(String(r.range.custom.to))
    && !isNaN(Date.parse(r.range.custom.from)) && !isNaN(Date.parse(r.range.custom.to)) && r.range.custom.from <= r.range.custom.to) {
    range = { custom: { from: r.range.custom.from, to: r.range.custom.to } };
  } else return null;
  let channels: ThreadScope["channels"];
  if (r.channels === undefined || r.channels === "all") channels = "all";
  else if (Array.isArray(r.channels) && r.channels.length > 0 && r.channels.every((c: unknown) => typeof c === "string" && CHANNELS.has(c))) {
    channels = Array.from(new Set(r.channels as string[]));
  } else return null;
  return { range, channels };
}

/** The scope's dates, absolute (UTC days). */
export function scopeDates(scope: ThreadScope, now = new Date()): { from: string; to: string } {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const to = day(now);
  if (typeof scope.range === "object") return { from: scope.range.custom.from, to: scope.range.custom.to };
  if (scope.range === "this_week") {
    // The week starts on Sunday (the product's markets).
    const d = new Date(now); d.setUTCDate(d.getUTCDate() - d.getUTCDay());
    return { from: day(d), to };
  }
  const n = scope.range === "last_30" ? 30 : 7;
  const d = new Date(now); d.setUTCDate(d.getUTCDate() - (n - 1));
  return { from: day(d), to };
}

/** The system line that tells the model what this thread is about. */
export function scopeLine(scope: ThreadScope, now = new Date(), locale: "he" | "en" = "en"): string {
  const { from, to } = scopeDates(scope, now);
  const ch = scope.channels === "all" ? "all channels" : `only these channels: ${scope.channels.join(", ")}`;
  const say = (d: string) => whenText(new Date(`${d}T00:00:00.000Z`), locale, "UTC", false);
  return [
    `Scope of this conversation: ${from} to ${to} (inclusive), ${ch}. When you mention the period, say it as "${say(from)} - ${say(to)}" (never the ISO dates).`,
    `Use the period for questions about activity over time (new conversations, messages, what was closed, trends): sinceISO=${from}T00:00:00.000Z.`,
    `Never apply the period to the current state: "how many are open", "what is waiting for us" are about now, whenever the conversation started; omit sinceISO for them, and use now: true (with the status) in system_query_conversations, also for a split of them ("how many of them are on WhatsApp").`,
    scope.channels === "all" ? "" : "Apply the channel filter to every count and search.",
    "If the user asks about another period or channel explicitly, answer that and say which one you used.",
  ].filter(Boolean).join(" ");
}

// ─── Threads ────────────────────────────────────────────────

export interface Owner { tenantId: string; userId: string }

const threadOut = (t: any) => ({
  id: t.id, title: t.title ?? null, scope: t.scope,
  // The scope as the dates the assistant uses today, for the chip ("1 Oct to 7 Oct").
  scopeDates: scopeDates(normalizeScope(t.scope) ?? DEFAULT_SCOPE),
  createdAt: t.createdAt, updatedAt: t.updatedAt,
  lastMessageAt: t.lastMessageAt ?? null, archivedAt: t.archivedAt ?? null,
});

/** The owner's thread, or null (another user's thread is exactly as missing). */
export async function ownThread(o: Owner, id: string) {
  if (!id || typeof id !== "string") return null;
  return prisma.assistantThread.findFirst({ where: { id, tenantId: o.tenantId, userId: o.userId } });
}

export async function createThread(o: Owner, scope: ThreadScope) {
  const t = await prisma.assistantThread.create({ data: { tenantId: o.tenantId, userId: o.userId, scope: scope as any } });
  return threadOut(t);
}

export async function listThreads(o: Owner, opts: { limit?: number; cursor?: string; archived?: boolean }) {
  const limit = Math.min(50, Math.max(1, Number(opts.limit) || 20));
  const base: any = { tenantId: o.tenantId, userId: o.userId, archivedAt: opts.archived ? { not: null } : null };
  let where = base;
  if (opts.cursor) {
    const c = await prisma.assistantThread.findFirst({ where: { id: opts.cursor, tenantId: o.tenantId, userId: o.userId }, select: { id: true, updatedAt: true } });
    if (c) where = { AND: [base, { OR: [{ updatedAt: { lt: c.updatedAt } }, { updatedAt: c.updatedAt, id: { lt: c.id } }] }] };
  }
  const rows = await prisma.assistantThread.findMany({
    where, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: limit + 1,
    select: { id: true, title: true, updatedAt: true, lastMessageAt: true },
  });
  const page = rows.slice(0, limit);
  return { data: page, nextCursor: rows.length > limit ? page[page.length - 1]!.id : null };
}

export async function patchThread(o: Owner, id: string, patch: { title?: string; scope?: ThreadScope; archived?: boolean }) {
  const t = await ownThread(o, id);
  if (!t) return null;
  const data: any = {};
  if (patch.title !== undefined) { data.title = withoutWideDashes(patch.title); data.titleSource = "user"; }
  if (patch.scope !== undefined) data.scope = patch.scope;
  if (patch.archived !== undefined) data.archivedAt = patch.archived ? (t.archivedAt ?? new Date()) : null;
  return threadOut(await prisma.assistantThread.update({ where: { id: t.id }, data }));
}

export async function deleteThread(o: Owner, id: string): Promise<boolean> {
  const t = await ownThread(o, id);
  if (!t) return false;
  const active = await activeRunOf(t.id);
  if (active) await requestCancel(active.runId);
  await (prisma as any).systemAgentMessage.deleteMany({ where: { tenantId: o.tenantId, userId: o.userId, sessionId: t.id } });
  await prisma.assistantThread.delete({ where: { id: t.id } });
  return true;
}

// ─── The run store (Redis) ──────────────────────────────────

const RUN_TTL_LIVE = 60 * 60; // a running answer never outlives an hour
export const RUN_TTL_DONE = 15 * 60; // resumable for 15 minutes after it ended
const kEvents = (runId: string) => `assistant:run:${runId}:events`;
const kMeta = (runId: string) => `assistant:run:${runId}:meta`;
const kCancel = (runId: string) => `assistant:run:${runId}:cancel`;
const kActive = (threadId: string) => `assistant:thread:${threadId}:active`;

export interface StoredEvent { seq: number; event: string; data: unknown }

async function appendEvent(runId: string, event: string, data: unknown): Promise<number> {
  const r = getRedis();
  // The list length after the push IS the event's sequence number (atomic).
  const len = await r.rpush(kEvents(runId), JSON.stringify({ event, data }));
  return len;
}

export async function readEvents(runId: string, after: number): Promise<StoredEvent[]> {
  const raw = await getRedis().lrange(kEvents(runId), after, -1);
  return raw.map((s, i) => ({ seq: after + i + 1, ...(JSON.parse(s) as { event: string; data: unknown }) }));
}

export async function runMeta(runId: string): Promise<Record<string, string> | null> {
  const m = await getRedis().hgetall(kMeta(runId));
  return m && Object.keys(m).length ? m : null;
}

export async function activeRunOf(threadId: string): Promise<{ runId: string; messageId: string; lastEventId: string } | null> {
  const r = getRedis();
  const runId = await r.get(kActive(threadId));
  if (!runId) return null;
  const meta = await runMeta(runId);
  if (!meta) return null;
  const len = await r.llen(kEvents(runId));
  return { runId, messageId: meta.messageId!, lastEventId: `${runId}:${len}` };
}

export async function requestCancel(runId: string): Promise<void> {
  await getRedis().set(kCancel(runId), "1", "EX", RUN_TTL_LIVE);
}

// ─── Suggestions ride the answer (no extra model call) ──────

export const SUGGESTIONS_MARKER = "[[suggestions]]";

/**
 * Splits the streamed answer from its trailing suggestions block. Text is
 * released as soon as it cannot be the start of the marker, so the answer
 * still streams token by token; nothing after the marker is ever shown.
 */
export class SuggestionsSplitter {
  private buf = "";
  private tail: string | null = null;
  push(delta: string): string {
    if (this.tail !== null) { this.tail += delta; return ""; }
    this.buf += delta;
    const at = this.buf.indexOf(SUGGESTIONS_MARKER);
    if (at >= 0) {
      const out = this.buf.slice(0, at);
      this.tail = this.buf.slice(at + SUGGESTIONS_MARKER.length);
      this.buf = "";
      return out;
    }
    let keep = 0;
    for (let n = Math.min(SUGGESTIONS_MARKER.length - 1, this.buf.length); n > 0; n--) {
      if (SUGGESTIONS_MARKER.startsWith(this.buf.slice(-n))) { keep = n; break; }
    }
    const out = this.buf.slice(0, this.buf.length - keep);
    this.buf = this.buf.slice(this.buf.length - keep);
    return out;
  }
  /** The held-back text (a false alarm) and the suggestions, when the answer ends. */
  end(): { rest: string; suggestions: string[] } {
    const rest = this.buf;
    this.buf = "";
    if (this.tail === null) return { rest, suggestions: [] };
    const m = this.tail.match(/\[[\s\S]*\]/);
    let items: unknown = [];
    try { items = m ? JSON.parse(m[0]) : []; } catch { items = []; }
    const suggestions = (Array.isArray(items) ? items : [])
      .filter((x): x is string => typeof x === "string" && !!x.trim())
      .map((x) => withoutWideDashes(x.trim()).slice(0, 160))
      .slice(0, 3);
    return { rest, suggestions };
  }
}

const LANG_NAME = { he: "Hebrew", en: "English" } as const;

/**
 * `[^s3]` stays only when s3 is a source of this answer. A dropped one takes
 * the space before it ("עונה בהן [^s1]." became "עונה בהן .").
 */
export function withValidCitations(text: string, ids: Set<string>): string {
  return text.replace(/[ \t]*\[\^([a-z]\d+)\]/g, (m, id) => (ids.has(id) ? m : ""));
}

export function threadSystemLines(scope: ThreadScope, locale: "he" | "en", now = new Date()): string[] {
  return [
    scopeLine(scope, now, locale),
    "Numbers come from the query tools and are shown as cards with your answer (a tool's `cards` says which): refer to them without describing where they appear on the screen, and never say you lack a breakdown a card shows. Write money exactly as a tool's text gives it (\"₪10,539.69\"), never a number with a currency code. Cite the source id a tool returns right after the claim it supports, as [^s1]. Never state a number no tool returned.",
    "Offer only what your tools can do. Never offer an export, a CSV or other file, a sync, or an action you have no tool for; when something is not available, say so and stop.",
    `Follow-up questions go ONLY in the ${SUGGESTIONS_MARKER} line (they appear as buttons). Never list them, or any \"want me to...\" menu of next steps, in the answer text.`,
    `Answer format for this screen: markdown limited to bold, italics, bullet and numbered lists, inline code and links (http(s) or in-app paths starting with /). No tables, images or HTML. After the answer, on its own last line, write ${SUGGESTIONS_MARKER} followed by a JSON array of 2 or 3 short follow-up questions the user may ask next, written in ${LANG_NAME[locale]}. Write nothing after that array.`,
  ];
}

// ─── Running an answer ──────────────────────────────────────

export interface StartRunInput {
  owner: Owner;
  thread: { id: string; scope: unknown; title: string | null; titleSource: string | null };
  text: string;
  locale: "he" | "en";
  operator: { userName?: string; userEmail?: string; userRole?: string; tenantName?: string; viewer?: Viewer; canReadCommerce?: boolean };
  authToken?: string;
}

export const RUN_TOKEN_BUDGET = () => Math.max(2000, Number(process.env.ASSISTANT_RUN_TOKEN_BUDGET) || 60_000);
const CANCEL_POLL_MS = 400;

/**
 * Claim the thread (one answer at a time), write the two messages and start
 * the run in the background. Null when an answer is already running.
 */
export async function startRun(input: StartRunInput): Promise<{ runId: string; userMessageId: string; messageId: string } | null> {
  const r = getRedis();
  const runId = `run_${crypto.randomBytes(12).toString("hex")}`;
  const claimed = await r.set(kActive(input.thread.id), runId, "EX", RUN_TTL_LIVE, "NX");
  if (claimed !== "OK") return null;
  try {
    const scope = normalizeScope(input.thread.scope) ?? { ...DEFAULT_SCOPE };
    const now = new Date();
    const user = await prisma.assistantMessage.create({
      data: { threadId: input.thread.id, tenantId: input.owner.tenantId, role: "user", text: input.text, status: "done", createdAt: now },
    });
    const msg = await prisma.assistantMessage.create({
      data: { threadId: input.thread.id, tenantId: input.owner.tenantId, role: "assistant", text: "", status: "streaming", scope: scope as any, runId, createdAt: new Date(now.getTime() + 1) },
    });
    await prisma.assistantThread.update({ where: { id: input.thread.id }, data: { lastMessageAt: now } });
    await r.hset(kMeta(runId), { threadId: input.thread.id, messageId: msg.id, userId: input.owner.userId, tenantId: input.owner.tenantId, status: "running" });
    await r.expire(kMeta(runId), RUN_TTL_LIVE);
    // The turn's language, for the answer's own chrome (step status, "N in all").
    await appendEvent(runId, "run.start", { runId, userMessageId: user.id, messageId: msg.id, lang: input.locale });
    await r.expire(kEvents(runId), RUN_TTL_LIVE);
    void executeRun(input, { runId, messageId: msg.id, scope }).catch((err) => console.error("[assistant-threads] run crashed:", err?.message));
    return { runId, userMessageId: user.id, messageId: msg.id };
  } catch (err) {
    await r.del(kActive(input.thread.id));
    throw err;
  }
}

interface Step { id: string; text: string; status: "running" | "done" | "failed" | "waiting_approval"; durationMs?: number; approvalRequestId?: string; startedAt: number }

async function executeRun(input: StartRunInput, run: { runId: string; messageId: string; scope: ThreadScope }) {
  const r = getRedis();
  const ac = new AbortController();
  const poll = setInterval(() => {
    r.get(kCancel(run.runId)).then((v) => { if (v) ac.abort(); }).catch(() => undefined);
  }, CANCEL_POLL_MS);

  const splitter = new SuggestionsSplitter();
  const steps = new Map<string, Step>();
  const blocks: unknown[] = [];
  const sources: Array<{ id: string }> = [];
  let pendingApproval: string | null = null;
  let text = "";
  let status: "done" | "cancelled" | "failed" = "done";
  let usage: any = null;

  const emit = (event: string, data: unknown) => appendEvent(run.runId, event, data);
  const emitText = async (t: string) => { if (t) { text += t; await emit("text.delta", { text: t }); } };

  try {
    await runAgent({
      operator: { tenantId: input.owner.tenantId, userId: input.owner.userId, ...input.operator, locale: input.locale },
      client: null,
      message: input.text,
      sessionId: input.thread.id,
      ephemeral: false,
      aiAgentId: null,
      authToken: input.authToken,
      signal: ac.signal,
      tokenBudget: RUN_TOKEN_BUDGET(),
      extraSystem: threadSystemLines(run.scope, input.locale),
      defaultPeriod: scopeDates(run.scope),
    }, async (ev: AgentRuntimeEvent) => {
      switch (ev.type) {
        case "token": await emitText(splitter.push(ev.text)); break;
        case "tool_start":
          steps.set(ev.toolCallId, { id: ev.toolCallId, text: ev.label, status: "running", startedAt: Date.now() });
          await emit("step.start", { stepId: ev.toolCallId, text: ev.label });
          break;
        case "plan_proposed":
        case "awaiting_approval":
          pendingApproval = ev.approvalRequestId;
          break;
        case "tool_end": {
          const s = steps.get(ev.toolCallId) ?? { id: ev.toolCallId, text: ev.label, status: "running" as const, startedAt: Date.now() };
          s.durationMs = Date.now() - s.startedAt;
          s.status = pendingApproval ? "waiting_approval" : ev.ok ? "done" : "failed";
          if (pendingApproval) s.approvalRequestId = pendingApproval;
          pendingApproval = null;
          steps.set(ev.toolCallId, s);
          await emit("step.done", { stepId: s.id, status: s.status, durationMs: s.durationMs, ...(s.approvalRequestId ? { approvalRequestId: s.approvalRequestId } : {}) });
          break;
        }
        case "round_end":
          // A round that called tools may have streamed a preamble: it is part of the answer.
          break;
        case "artifacts":
          // Computed by the query tool, shown exactly as computed.
          for (const b of ev.blocks) { blocks.push(b); await emit("block", { block: b }); }
          if (ev.source) sources.push(ev.source as { id: string });
          break;
        case "cancelled": status = "cancelled"; break;
        case "error":
          status = "failed";
          await emit("error", { code: ev.code ?? "AI_UNAVAILABLE", message: ev.message });
          break;
        case "done": usage = ev.usage; break;
      }
    });
  } catch (err: any) {
    status = ac.signal.aborted ? "cancelled" : "failed";
    if (status === "failed") await emit("error", { code: "AI_UNAVAILABLE", message: "the assistant is not available right now" }).catch(() => undefined);
  } finally {
    clearInterval(poll);
  }
  if (ac.signal.aborted) status = "cancelled";

  const { rest, suggestions } = splitter.end();
  if (rest && status !== "cancelled") await emitText(rest);
  else if (rest) text += rest;
  if (suggestions.length && status === "done") await emit("suggestions", { items: suggestions });
  // A citation must point at a source of this answer; any other is dropped.
  text = withValidCitations(text, new Set(sources.map((x) => x.id)));
  if (sources.length) await emit("sources", { items: sources });

  // Defensive: a tool always reports before the run ends, so only a crash
  // mid-tool leaves a step running; saved, it did not finish.
  const stepList = [...steps.values()].map(({ startedAt: _s, ...s }) => (s.status === "running" ? { ...s, status: "failed" as const } : s));
  await prisma.assistantMessage.update({
    where: { id: run.messageId },
    data: { text: text.trim(), status, steps: stepList as any, suggestions: (status === "done" ? suggestions : []) as any, blocks: blocks as any, sources: sources as any, usage: usage ?? undefined },
  }).catch((err) => console.error("[assistant-threads] save failed:", err?.message));

  // The first answer names the thread, unless the user named it.
  if (status === "done" && !input.thread.title && input.thread.titleSource !== "user") {
    const title = await autoTitle(input.owner.tenantId, input.text, text, input.locale).catch(() => null);
    if (title) {
      const written = await prisma.assistantThread.updateMany({
        where: { id: input.thread.id, titleSource: null },
        data: { title, titleSource: "auto" },
      }).catch(() => ({ count: 0 }));
      if (written.count) await emit("thread.title", { title });
    }
  }
  await prisma.assistantThread.update({ where: { id: input.thread.id }, data: { lastMessageAt: new Date() } }).catch(() => undefined);

  await emit("message.done", { messageId: run.messageId, status, ...(usage ? { usage } : {}) });
  await r.hset(kMeta(run.runId), "status", status).catch(() => undefined);
  await Promise.all([
    r.expire(kEvents(run.runId), RUN_TTL_DONE),
    r.expire(kMeta(run.runId), RUN_TTL_DONE),
    r.del(kCancel(run.runId)),
  ]).catch(() => undefined);
  // Release the thread only if it is still ours.
  if ((await r.get(kActive(input.thread.id)).catch(() => null)) === run.runId) await r.del(kActive(input.thread.id)).catch(() => undefined);
}

/** One small model call (logged and charged like every call), in the interface language. */
export async function autoTitle(tenantId: string, question: string, answer: string, locale: "he" | "en"): Promise<string | null> {
  const res = await generateResponse({
    tenantId,
    model: getMicroModel(),
    reasoningEffort: "minimal",
    maxTokens: 40,
    metadata: { type: "assistant_thread_title" },
    messages: [
      { role: "system", content: `Write a short title (at most 6 words) for this conversation, in ${LANG_NAME[locale]}. Plain text only: no quotes, no markdown, no final punctuation.` },
      { role: "user", content: `Question: ${question.slice(0, 500)}\n\nAnswer: ${answer.slice(0, 800)}` },
    ],
  });
  const t = withoutWideDashes(String(res.content ?? "").split("\n")[0]!.replace(/^["'\s*#]+|["'\s*.]+$/g, "").trim()).slice(0, 120);
  return t || null;
}

/** The screen's view of a thread: messages, and the answer still being written. */
export async function threadView(o: Owner, id: string) {
  const t = await ownThread(o, id);
  if (!t) return null;
  const [rows, activeRun] = await Promise.all([
    prisma.assistantMessage.findMany({ where: { threadId: t.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
    activeRunOf(t.id),
  ]);
  // An answer's language is its question's. Not stored: a question without a
  // clear language (a number) has no `lang`, and the client keeps the UI's,
  // which is what that turn fell back to.
  let question = "";
  const messages = rows.map((m: any) => {
    if (m.role === "user") question = m.text ?? "";
    const lang = m.role === "assistant" ? questionLanguage(question) : null;
    return {
      id: m.id, threadId: m.threadId, role: m.role, text: m.text,
      // A "streaming" row whose run is gone (the process died) did not finish.
      status: m.status === "streaming" && activeRun?.messageId !== m.id ? "failed" : m.status,
      ...(m.role === "assistant" ? { steps: m.steps ?? [], scope: m.scope, suggestions: m.suggestions ?? [], blocks: m.blocks ?? [], sources: m.sources ?? [], actions: [], runId: m.runId } : {}),
      ...(lang ? { lang } : {}),
      createdAt: m.createdAt,
    };
  });
  return { thread: threadOut(t), messages, activeRun };
}
