/**
 * Automation runs (Studio > Automations): the ONE place an event becomes a
 * run, a run is resumed, and a run ends. The walking itself is the existing
 * flow walker (flow-executor.service), entered with a run context.
 *
 *   ★ one run per event     AutomationRun is unique on (flowId, eventKey):
 *                           a duplicate delivery or a job retry loses the
 *                           insert race and does nothing.
 *   ★ no loops              an automation's own writes emit no events, and
 *                           one conversation runs at most LOOP_GUARD_PER_MIN
 *                           automation runs a minute.
 *   ★ one responder         the first run that answers an inbound (sent,
 *                           parked for a reply, or handed on) ends dispatch
 *                           for it, and the caller does not let the AI answer.
 *   ★ ownership restored    a run that parked claims the conversation
 *                           (handledBy "flow") and gives it back to whoever
 *                           had it when the run ends.
 */
import { prisma, publishEvent } from "@chatcenter/shared";
import {
  executeSubFlow,
  executeWebhookFlow,
  type AutomationRunCtx,
  type FlowExecutionResult,
} from "./flow-executor.service";

export const LOOP_GUARD_PER_MIN = 5;

export type AutomationTrigger = "message_received" | "new_customer" | "message_from_ad" | "button_tapped" | "tag_added" | "cart_abandoned" | "comment_received" | "schedule" | "webhook" | "call_missed" | "call_answered";

export interface TriggerEvent {
  type: AutomationTrigger;
  channel?: string | null;    // ChannelType, any case
  message?: string;
  tag?: string | null;
  /** The ad the conversation came from (Meta referral source id). */
  adId?: string | null;
  /** The tapped button / list row id of an interactive reply. */
  payload?: string | null;
  /** The post / media a comment was left on. */
  postId?: string | null;
}

// ── Matching (pure) ────────────────────────────────────────────────────────

const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();

/** Does this automation's trigger config accept the event? */
export function triggerMatches(flow: { triggerType: string | null; triggerConfig: any }, ev: TriggerEvent): boolean {
  if (flow.triggerType !== ev.type) return false;
  const c = flow.triggerConfig && typeof flow.triggerConfig === "object" ? flow.triggerConfig : {};
  const channels: string[] = Array.isArray(c.channels) ? c.channels.map((x: string) => String(x).toUpperCase()) : [];
  if (channels.length && !channels.includes(String(ev.channel ?? "").toUpperCase())) return false;
  if (ev.type === "message_received" || ev.type === "comment_received") {
    if (ev.type === "comment_received") {
      const posts: string[] = Array.isArray(c.postIds) ? c.postIds.map(norm).filter(Boolean) : [];
      if (posts.length && !(ev.postId && posts.includes(norm(ev.postId)))) return false;
    }
    const keywords: string[] = Array.isArray(c.keywords) ? c.keywords.map(norm).filter(Boolean) : [];
    if (!keywords.length) return true;
    const msg = norm(ev.message);
    if (!msg) return false;
    const match = c.match ?? "contains";
    if (match === "exact") return keywords.includes(msg);
    if (match === "any_word") {
      const words = new Set(msg.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
      return keywords.some((k) => words.has(k));
    }
    return keywords.some((k) => msg.includes(k));
  }
  if (ev.type === "message_from_ad") {
    // Ad ids are copied by hand out of Meta's UI: trimmed, case-insensitive.
    const ads: string[] = Array.isArray(c.adIds) ? c.adIds.map(norm).filter(Boolean) : [];
    return !ads.length || (!!ev.adId && ads.includes(norm(ev.adId)));
  }
  if (ev.type === "button_tapped") {
    if (!ev.payload) return false;
    const payloads: string[] = Array.isArray(c.payloads) ? c.payloads.map(norm).filter(Boolean) : [];
    return !payloads.length || payloads.includes(norm(ev.payload));
  }
  if (ev.type === "tag_added") {
    const tags: string[] = Array.isArray(c.tags) ? c.tags.map(norm) : [];
    return !!ev.tag && tags.includes(norm(ev.tag));
  }
  return true;
}

/** The run's status after a walk. */
export function statusAfter(result: FlowExecutionResult | null, error: unknown): "waiting" | "completed" | "failed" | "skipped" {
  if (error) return "failed";
  if (!result) return "completed";
  if (result.reason === "automation_inactive") return "skipped";
  if (result.reason === "wait_for_reply" || result.reason === "waiting_on_timer") return "waiting";
  return "completed";
}

const FAILED_ACTIONS = new Set(["http_error", "task_failed", "notify_failed", "no_branch", "send_failed"]);
const WAITING_ACTIONS = new Set(["paused_for_reply", "sent_and_paused", "prompted_and_paused", "scheduled_resume", "waiting_on_timer"]);
const SKIPPED_ACTIONS = new Set(["skip_noop", "skip_unknown"]);

/** The walker's trace as run-log steps. */
export function stepsFromTrace(trace: FlowExecutionResult["trace"]): Array<{ nodeId: string; nodeType: string; status: string; branch: string | null; output: any }> {
  return (trace ?? [])
    .filter((t) => t.nodeId && t.nodeId !== "(resume)" && t.type !== "-")
    .map((t) => ({
      nodeId: t.nodeId,
      nodeType: t.type,
      status: FAILED_ACTIONS.has(t.action) ? "failed" : WAITING_ACTIONS.has(t.action) ? "waiting" : SKIPPED_ACTIONS.has(t.action) ? "skipped" : "ok",
      branch: typeof t.detail?.branch === "string" ? t.detail.branch : null,
      output: { action: t.action, ...(t.detail && typeof t.detail === "object" ? t.detail : {}) },
    }));
}

// ── Settling a run ─────────────────────────────────────────────────────────

async function settle(opts: {
  tenantId: string;
  run: AutomationRunCtx;
  conversationId: string | null;
  result: FlowExecutionResult | null;
  error: unknown;
}): Promise<string> {
  const { tenantId, run, conversationId, result, error } = opts;
  const status = statusAfter(result, error);
  const steps = stepsFromTrace(result?.trace ?? []);
  if (error) {
    steps.push({
      nodeId: run.currentNodeId ?? "?", nodeType: "?", status: "failed", branch: null,
      output: { error: String((error as any)?.message ?? error).slice(0, 500) },
    });
  }
  // Which node failed is known by id; its type is on the graph.
  if (steps.length) {
    await prisma.automationRunStep.createMany({
      data: steps.map((s) => ({ tenantId, runId: run.id, ...s, output: s.output ?? undefined })),
    }).catch((err: any) => console.warn("[automations] run steps not written:", err?.message));
  }
  const ended = status !== "waiting";
  await prisma.automationRun.update({
    where: { id: run.id },
    data: {
      status,
      currentNodeId: ended ? null : run.currentNodeId,
      ...(run.answered ? { answeredInbound: true } : {}),
      ...(error ? { error: `failed: ${String((error as any)?.message ?? error).slice(0, 300)}` } : {}),
      ...(status === "skipped" ? { error: "automation_inactive" } : {}),
      ...(ended ? { endedAt: new Date() } : {}),
    },
  });
  if (ended && conversationId) await release(tenantId, conversationId, run, status === "failed");
  return status;
}

/**
 * The run is over: drop its cursor and give the conversation back. A run
 * that failed leaves a conversation no one owns with the team, never with
 * nobody.
 */
async function release(tenantId: string, conversationId: string, run: AutomationRunCtx, failed: boolean) {
  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, tenantId },
    select: { automationRunId: true, handledBy: true, flowVariables: true, assignedAgentId: true, isHandedOver: true, status: true },
  });
  if (!conv) return;
  const data: Record<string, unknown> = {};
  if (conv.automationRunId === run.id) Object.assign(data, { automationRunId: null, chatbotNodeId: null, chatbotFlowId: null });
  const vars = (conv.flowVariables && typeof conv.flowVariables === "object" ? conv.flowVariables : {}) as Record<string, unknown>;
  if (conv.handledBy === "flow") {
    const prev = vars.__automationRunId === run.id ? (vars.__automationPrevOwner as string | null | undefined) : run.prevOwner;
    data.handledBy = prev === "flow" ? null : prev ?? null;
  }
  if (vars.__automationRunId === run.id) {
    const { __automationRunId, __automationPrevOwner, ...rest } = vars;
    data.flowVariables = rest;
  }
  const nobody = !conv.assignedAgentId && !conv.isHandedOver && (data.handledBy ?? conv.handledBy) == null;
  if (failed && nobody && conv.status !== "CLOSED") Object.assign(data, { status: "WAITING", handledBy: "human" });
  if (!Object.keys(data).length) return;
  await prisma.conversation.update({ where: { id: conversationId }, data: data as any });
  if (data.status === "WAITING") {
    publishEvent({ event: "conversation:updated", tenantId, data: { id: conversationId, status: "WAITING", handledBy: "human" } }).catch(() => {});
  }
}

function isUniqueViolation(err: any): boolean {
  return err?.code === "P2002";
}

// ── Starting runs ──────────────────────────────────────────────────────────

/**
 * Fire every live automation of these trigger types that accepts the event,
 * in the order they went live, until one answers. Returns whether one did.
 */
export async function runAutomationsForEvent(ev: {
  tenantId: string;
  types: AutomationTrigger[];
  eventKey: string;
  conversationId: string | null;
  contactId?: string | null;
  channel: string;               // lowercase inbound channel, as the walker expects
  message: string;
  replyPayload?: string | null;
  tag?: string | null;
  adId?: string | null;
  /** Only these automations (a per-automation delayed check, e.g. carts). */
  onlyFlowIds?: string[];
  /** The event's variables for the walk ({{cart_url}}, ...). */
  vars?: Record<string, unknown>;
}): Promise<{ answered: boolean; runs: Array<{ id: string; flowId: string; status: string }> }> {
  const out = { answered: false, runs: [] as Array<{ id: string; flowId: string; status: string }> };
  const flows = await prisma.chatbotFlow.findMany({
    where: { tenantId: ev.tenantId, isActive: true, triggerType: { in: ev.types }, ...(ev.onlyFlowIds ? { id: { in: ev.onlyFlowIds } } : {}) },
    orderBy: { activatedAt: "asc" },
    select: { id: true, triggerType: true, triggerConfig: true },
  });
  const matching = flows.filter((f: any) => ev.types.some((type) => triggerMatches(f, { type, channel: ev.channel, message: ev.message, tag: ev.tag, adId: ev.adId, payload: ev.replyPayload })));
  if (!matching.length) return out;

  let prevOwner: string | null = null;
  if (ev.conversationId) {
    // Loop guard: whatever is generating events, a conversation does not
    // run automations without end.
    const recent = await prisma.automationRun.count({
      where: { tenantId: ev.tenantId, conversationId: ev.conversationId, startedAt: { gte: new Date(Date.now() - 60_000) } },
    });
    if (recent >= LOOP_GUARD_PER_MIN) {
      console.warn(`[automations] loop guard: conversation ${ev.conversationId} ran ${recent} automations this minute; skipping`);
      return out;
    }
    const conv = await prisma.conversation.findFirst({ where: { id: ev.conversationId, tenantId: ev.tenantId }, select: { handledBy: true } });
    prevOwner = conv?.handledBy ?? null;
  }

  for (const flow of matching as any[]) {
    let row: { id: string };
    try {
      row = await prisma.automationRun.create({
        data: {
          tenantId: ev.tenantId, flowId: flow.id, triggerType: flow.triggerType, eventKey: ev.eventKey,
          conversationId: ev.conversationId, contactId: ev.contactId ?? null, status: "running",
        },
        select: { id: true },
      });
    } catch (err) {
      if (isUniqueViolation(err)) continue; // this event already ran this automation
      throw err;
    }
    const run: AutomationRunCtx = { id: row.id, flowId: flow.id, answered: false, currentNodeId: null, prevOwner };
    let result: FlowExecutionResult | null = null;
    let error: unknown = null;
    try {
      result = ev.conversationId
        ? await executeSubFlow({
            tenantId: ev.tenantId, conversationId: ev.conversationId, message: ev.message, channel: ev.channel,
            flowId: flow.id, replyPayload: ev.replyPayload ?? null, run, vars: ev.vars,
          })
        : await executeWebhookFlow({ tenantId: ev.tenantId, workflowId: flow.id, payload: {}, run });
    } catch (err) {
      error = err;
      console.error(`[automations] run ${run.id} (automation ${flow.id}) failed:`, (err as any)?.message ?? err);
    }
    const status = await settle({ tenantId: ev.tenantId, run, conversationId: ev.conversationId, result, error });
    out.runs.push({ id: run.id, flowId: flow.id, status });
    if (run.answered || status === "waiting") {
      // One responder per inbound, and one parked run per conversation.
      out.answered = out.answered || run.answered;
      break;
    }
  }
  return out;
}

/** A customer-less run (schedule, webhook): the payload is `{{body.*}}`. */
export async function runContextFree(opts: {
  tenantId: string;
  flowId: string;
  triggerType: AutomationTrigger;
  eventKey: string;
  payload: unknown;
}): Promise<{ id: string; status: string } | null> {
  let row: { id: string };
  try {
    row = await prisma.automationRun.create({
      data: { tenantId: opts.tenantId, flowId: opts.flowId, triggerType: opts.triggerType, eventKey: opts.eventKey, status: "running" },
      select: { id: true },
    });
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    throw err;
  }
  const run: AutomationRunCtx = { id: row.id, flowId: opts.flowId, answered: false, currentNodeId: null, prevOwner: null };
  let result: FlowExecutionResult | null = null;
  let error: unknown = null;
  try {
    result = await executeWebhookFlow({ tenantId: opts.tenantId, workflowId: opts.flowId, payload: opts.payload, run });
  } catch (err) {
    error = err;
  }
  // A customer-less path cannot wait for anyone.
  const status = await settle({ tenantId: opts.tenantId, run, conversationId: null, result: result && result.reason === "wait_for_reply" ? { ...result, reason: "end_node" } : result, error });
  return { id: run.id, status };
}

// ── Resuming a parked run ──────────────────────────────────────────────────

/**
 * Continue the run parked on this conversation: an inbound reply, or its
 * timer. A timed Wait is moved only by its timer; an inbound during it does
 * not count as answered, so the conversation's owner answers as usual.
 */
export async function resumeAutomationRun(opts: {
  tenantId: string;
  conversationId: string;
  runId: string;
  message: string;
  channel: string;
  replyPayload?: string | null;
  fromTimer?: boolean;
  timeout?: boolean;
}): Promise<{ answered: boolean; status: string }> {
  const [runRow, conv] = await Promise.all([
    prisma.automationRun.findFirst({ where: { id: opts.runId, tenantId: opts.tenantId }, select: { id: true, flowId: true, status: true, triggerType: true, eventKey: true } }),
    prisma.conversation.findFirst({ where: { id: opts.conversationId, tenantId: opts.tenantId }, select: { chatbotNodeId: true, automationRunId: true, flowVariables: true, handledBy: true } }),
  ]);
  if (!conv) return { answered: false, status: "gone" };
  const vars = (conv.flowVariables && typeof conv.flowVariables === "object" ? conv.flowVariables : {}) as Record<string, any>;
  const run: AutomationRunCtx = {
    id: opts.runId, flowId: runRow?.flowId ?? "", answered: false, currentNodeId: conv.chatbotNodeId ?? null,
    prevOwner: vars.__automationRunId === opts.runId ? vars.__automationPrevOwner ?? null : conv.handledBy ?? null,
  };
  if (!runRow || runRow.status !== "waiting" || !conv.chatbotNodeId) {
    // Nothing to resume: never leave the conversation pointing at it.
    if (conv.automationRunId === opts.runId) await release(opts.tenantId, opts.conversationId, run, false);
    return { answered: false, status: runRow?.status ?? "gone" };
  }
  // A cart reminder stops the moment the customer buys: a purchase that
  // arrived while the run waited ends it before anything else is sent.
  if ((runRow as any).triggerType === "cart_abandoned" && String((runRow as any).eventKey ?? "").startsWith("cart:")) {
    const { isCheckoutDone } = await import("./cart.service");
    if (await isCheckoutDone(opts.tenantId, String((runRow as any).eventKey).slice(5))) {
      await prisma.automationRun.update({ where: { id: opts.runId }, data: { status: "completed", error: "stopped: purchased", currentNodeId: null, endedAt: new Date() } });
      await release(opts.tenantId, opts.conversationId, run, false);
      return { answered: false, status: "completed" };
    }
  }
  let result: FlowExecutionResult | null = null;
  let error: unknown = null;
  try {
    result = await executeSubFlow({
      tenantId: opts.tenantId, conversationId: opts.conversationId, message: opts.message, channel: opts.channel,
      flowId: runRow.flowId, resumeNodeId: conv.chatbotNodeId, replyPayload: opts.replyPayload ?? null,
      fromTimer: !!opts.fromTimer, timeout: !!opts.timeout, run,
    });
  } catch (err) {
    error = err;
    console.error(`[automations] resume of run ${run.id} failed:`, (err as any)?.message ?? err);
  }
  if (!error && result?.reason === "waiting_on_timer") return { answered: false, status: "waiting" };
  const status = await settle({ tenantId: opts.tenantId, run, conversationId: opts.conversationId, result, error });
  return { answered: run.answered, status };
}

// ── The inbound hook ───────────────────────────────────────────────────────

/**
 * Automations for one inbound message, before the AI or the playbook. Returns
 * true when an automation answered it (the caller then stops).
 */
export async function automationsForInbound(opts: {
  tenantId: string;
  conversation: {
    id: string; channel: string; customerExternalId: string; handledBy?: string | null; chatbotNodeId?: string | null; automationRunId?: string | null;
    fromAdCampaign?: boolean | null; referralSourceId?: string | null;
  };
  messageId: string;
  message: string;
  channel: string;          // lowercase
  replyPayload?: string | null;
  contactId?: string | null;
}): Promise<boolean> {
  const c = opts.conversation;
  // A run is parked here: this message is its to take (or, on a timed wait,
  // nobody's, and no other automation starts beside it).
  if (c.automationRunId) {
    // A run that began on a comment: the customer replied, so the 24 h
    // comment-to-DM bridge no longer governs this conversation (the idle
    // sweep would otherwise close it mid-conversation).
    if ((c as any).flowExpiresAt) {
      await prisma.conversation.updateMany({ where: { id: c.id, tenantId: opts.tenantId }, data: { flowExpiresAt: null } });
    }
    const r = await resumeAutomationRun({
      tenantId: opts.tenantId, conversationId: c.id, runId: c.automationRunId,
      message: opts.message, channel: opts.channel, replyPayload: opts.replyPayload,
    });
    return r.answered;
  }
  // A playbook flow is waiting for exactly this reply: it keeps it.
  if (c.chatbotNodeId && c.handledBy === "flow") return false;

  const [inboundCount, otherConversations] = await Promise.all([
    prisma.message.count({ where: { conversationId: c.id, direction: "INBOUND" } }),
    prisma.conversation.count({ where: { tenantId: opts.tenantId, channel: c.channel as any, customerExternalId: c.customerExternalId, id: { not: c.id } } }),
  ]);
  const isNewCustomer = inboundCount <= 1 && otherConversations === 0;
  // "Message from an ad": the conversation's FIRST message, when it came from
  // an ad (Meta's referral, or a billed ad entry point). Once per conversation.
  const fromAd = inboundCount <= 1 && (!!c.fromAdCampaign || !!c.referralSourceId);
  const types: AutomationTrigger[] = [
    ...(fromAd ? ["message_from_ad" as const] : []),
    ...(isNewCustomer ? ["new_customer" as const] : []),
    // A tap with no flow waiting for it (e.g. a campaign template's button).
    ...(opts.replyPayload ? ["button_tapped" as const] : []),
    "message_received",
  ];
  const r = await runAutomationsForEvent({
    tenantId: opts.tenantId,
    types,
    adId: c.referralSourceId ?? null,
    eventKey: `msg:${opts.messageId}`,
    conversationId: c.id,
    contactId: opts.contactId ?? null,
    channel: opts.channel,
    message: opts.message,
    replyPayload: opts.replyPayload ?? null,
  });
  return r.answered;
}

/**
 * Has an automation already answered in this conversation? Then the first
 * inbound no automation answered is the one the playbook routes (routing
 * used to look only at "is this the conversation's first message").
 */
export async function automationAnsweredBefore(tenantId: string, conversationId: string): Promise<boolean> {
  const n = await prisma.automationRun.count({ where: { tenantId, conversationId, answeredInbound: true } });
  return n > 0;
}

// ── Events without an inbound message ──────────────────────────────────────

/**
 * A tag was added to a customer (by a person or the AI employee; an
 * automation's own add_tag emits nothing). The run happens in the customer's
 * latest conversation; with none, there is no one to run it for.
 */
export async function runTagAdded(ev: { tenantId: string; contactId: string; tag: string; eventKey: string }) {
  const contact = await prisma.contact.findFirst({
    where: { id: ev.contactId, tenantId: ev.tenantId },
    select: { id: true, channel: true, externalId: true },
  });
  if (!contact) return { answered: false, runs: [] };
  const conv = await prisma.conversation.findFirst({
    where: { tenantId: ev.tenantId, channel: contact.channel as any, customerExternalId: contact.externalId },
    orderBy: { createdAt: "desc" },
    select: { id: true, channel: true, assignedAgentId: true, isHandedOver: true, automationRunId: true },
  });
  // A person owns it, or a run is already parked there: automations stay out.
  if (!conv || conv.assignedAgentId || conv.isHandedOver || conv.automationRunId) return { answered: false, runs: [] };
  return runAutomationsForEvent({
    tenantId: ev.tenantId, types: ["tag_added"], eventKey: ev.eventKey,
    conversationId: conv.id, contactId: contact.id, channel: String(conv.channel).toLowerCase(), message: "", tag: ev.tag,
  });
}

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** The wall-clock minute in a timezone: { day: "mon", hhmm: "09:00", date: "2026-10-06" }. */
export function wallClock(now: Date, timeZone: string): { day: string; hhmm: string; date: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(now).map((p) => [p.type, p.value]),
  );
  return { day: String(parts.weekday).slice(0, 3).toLowerCase(), hhmm: `${parts.hour}:${parts.minute}`, date: `${parts.year}-${parts.month}-${parts.day}` };
}

/** Is a schedule trigger due at this minute? Returns the minute's event key, or null. */
export function scheduleDue(config: any, now: Date, fallbackTz = "Asia/Jerusalem"): string | null {
  const at = typeof config?.at === "string" ? config.at : null;
  if (!at) return null;
  let tz = typeof config?.timezone === "string" && config.timezone ? config.timezone : fallbackTz;
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); } catch { tz = fallbackTz; }
  const w = wallClock(now, tz);
  if (w.hhmm !== at) return null;
  const days: string[] = Array.isArray(config?.days) ? config.days : [];
  if (days.length && !days.includes(w.day)) return null;
  if (!DAY_KEYS.includes(w.day)) return null;
  return `sched:${w.date}T${w.hhmm}`;
}

/**
 * One scheduler tick: run every live schedule automation due this minute.
 * Safe to call often and from several workers - the minute's event key
 * makes each due run happen once.
 */
export async function runDueSchedules(now = new Date()): Promise<number> {
  const flows = await prisma.chatbotFlow.findMany({
    where: { isActive: true, triggerType: "schedule" },
    select: { id: true, tenantId: true, triggerConfig: true },
  });
  let started = 0;
  for (const f of flows as any[]) {
    const key = scheduleDue(f.triggerConfig, now);
    if (!key) continue;
    const r = await runContextFree({ tenantId: f.tenantId, flowId: f.id, triggerType: "schedule", eventKey: key, payload: { firedAt: now.toISOString() } })
      .catch((err) => { console.error(`[automations] schedule ${f.id} failed:`, err?.message); return null; });
    if (r) started++;
  }
  return started;
}

let scheduleTimer: NodeJS.Timeout | null = null;
/** Ticks twice a minute so a due minute is never missed; dedupe keeps one run. */
export function startAutomationScheduler(): void {
  if (scheduleTimer) return;
  scheduleTimer = setInterval(() => { runDueSchedules().catch((err) => console.error("[automations] scheduler tick:", err?.message)); }, 30_000);
  scheduleTimer.unref?.();
}
