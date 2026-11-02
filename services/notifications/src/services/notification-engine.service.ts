/**
 * Notification engine - fan-out logic.
 *
 * Pulled out of the dispatcher worker so it's pure-ish (DB + Redis only,
 * no BullMQ side-effects beyond enqueue) and unit-testable.
 *
 *   processEvent(event)
 *     → loads NotificationPreference rows for (tenantId, eventType, enabled)
 *     → prefers department-scoped rows over tenant-default (NULL) rows
 *     → evaluates condition expressions
 *     → dedupes via Redis SETNX (5min TTL)
 *     → resolves recipients
 *     → for each recipient × channel → enqueue dispatch (in-app inline,
 *       email/slack/etc. via per-channel queues)
 *
 * Multi-tenant safe: every read is filtered by tenantId, recipients are
 * filtered by tenant_id at SQL level (resolveRecipients), and dispatch
 * payloads carry tenantId for downstream sanity-checks.
 */

import { createHash } from "crypto";
import { prisma, getRedis } from "@chatcenter/shared";
import type { JobsOptions } from "bullmq";
import type { SystemEvent } from "./event-emitter.service";
import { resolveRecipients, type RecipientSpec, type ResolvedUser } from "./recipient-resolver.service";
import { renderTemplate } from "./templates";
import { localeForRecipient } from "./platform-whatsapp";
import { deliverWhatsAppNotice, wantsWhatsApp } from "./whatsapp-notice.service";
import { createInAppNotification } from "./in-app.service";
import { sendPushToUser } from "./push-sender";
import { loadPersonal, personalAllows, workspaceTimeZone, localTime, PERSONAL_DEFAULTS } from "./personal-preferences.service";
import {
  getNotificationsEmailQueue,
  DEFAULT_NOTIF_JOB_OPTS,
} from "./queues";

// ── Conditions DSL ────────────────────────────────────────

export type ConditionOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "contains";

export interface Condition {
  field: string;       // dot-path into event.data, e.g. "valueEstimate" or "customer.tier"
  op: ConditionOp;
  value: unknown;
}

function getField(obj: Record<string, unknown>, path: string): unknown {
  if (!path) return undefined;
  const parts = path.split(".");
  let cur: any = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur;
}

function evalOp(actual: unknown, op: ConditionOp, expected: unknown): boolean {
  switch (op) {
    case "eq":  return actual === expected;
    case "neq": return actual !== expected;
    case "gt":  return typeof actual === "number" && typeof expected === "number" && actual > expected;
    case "gte": return typeof actual === "number" && typeof expected === "number" && actual >= expected;
    case "lt":  return typeof actual === "number" && typeof expected === "number" && actual < expected;
    case "lte": return typeof actual === "number" && typeof expected === "number" && actual <= expected;
    case "in":  return Array.isArray(expected) && expected.includes(actual as any);
    case "contains":
      if (typeof actual === "string") return typeof expected === "string" && actual.includes(expected);
      if (Array.isArray(actual)) return (actual as unknown[]).includes(expected as any);
      return false;
    default:    return false;
  }
}

export function evaluateConditions(conditions: unknown, data: Record<string, unknown>): boolean {
  if (!conditions) return true;
  if (typeof conditions === "string") {
    // CEL-lite string form is treated as a no-op for now (placeholder for the
    // future CEL evaluator). Letting it pass keeps preferences forward-compatible.
    return true;
  }
  if (!Array.isArray(conditions)) return true;
  for (const c of conditions as Condition[]) {
    if (!c || typeof c.field !== "string" || typeof c.op !== "string") continue;
    if (!evalOp(getField(data, c.field), c.op, c.value)) return false;
  }
  return true;
}

// ── Dedup ─────────────────────────────────────────────────

function hashEventData(data: Record<string, unknown>): string {
  // Stable JSON.stringify isn't strictly required because we're hashing for
  // approximate dedup, not equality - small key-order drift is acceptable.
  // Use a sorted-keys shallow stringify to keep it deterministic across runs.
  const keys = Object.keys(data).sort();
  const sorted: Record<string, unknown> = {};
  for (const k of keys) sorted[k] = data[k];
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex").slice(0, 16);
}

const DEDUP_TTL_SECONDS = 5 * 60;

async function shouldDeliver(tenantId: string, eventType: string, data: Record<string, unknown>): Promise<boolean> {
  const key = `notif:dedup:${tenantId}:${eventType}:${hashEventData(data)}`;
  try {
    const redis = getRedis();
    // SET NX EX - atomic "claim if absent". Returns "OK" on first claim,
    // null when the dedup key already exists.
    const ok = await (redis as any).set(key, "1", "EX", DEDUP_TTL_SECONDS, "NX");
    return ok === "OK" || ok === true;
  } catch (err: any) {
    // If Redis is down, fail open - better to deliver duplicates than to
    // silently drop a high-value notification.
    console.warn("[notifications.dedup] redis check failed:", err?.message);
    return true;
  }
}

// ── Main entry ────────────────────────────────────────────

export async function processEvent(event: SystemEvent): Promise<void> {
  // An automation's "Notify team" names its own recipients: it is a message
  // the automation's author wrote to chosen people, not an event an admin
  // routes with preferences.
  if ((event.type as string) === AUTOMATION_NOTICE) {
    await deliverAutomationNotice(event);
    return;
  }

  // 1. The workspace's rules for this event (department-scoped preferred).
  let effective = await rulesFor(event.tenantId, event.type, event.departmentId);
  // An inbound customer message is never routed by its own rules: a rule
  // could otherwise broadcast every customer message to the admins, by email.
  // With an assignee it goes to them (defaultRoute); in the team's queue, to
  // everyone who can read conversations (push only).
  if (ASSIGNEE_PUSH_ONLY.has(event.type)) {
    effective = (event.data as any)?.assignedAgentId ? [] : teamQueueRoutes(event);
  }
  // No rule for this event in the workspace: the built-in route, so it
  // reaches someone (design 15, Step 1). It was silently dropped.
  if (effective.length === 0) {
    const fallback = defaultRoute(event);
    if (!fallback) return;
    effective = [fallback];
  }

  // 2. Dedup once per event payload - even if multiple prefs would match,
  //    we don't want to re-fire identical bursts.
  const ok = await shouldDeliver(event.tenantId, event.type, event.data);
  if (!ok) return;

  // 3. Render for each recipient: their language (their own, else the
  //    workspace's), and for a plan their words ("you" when it is theirs).
  const rendered = new Map<string, ReturnType<typeof renderTemplate>>();
  const tplFor = async (userId: string) => {
    const locale = await localeForRecipient(event.tenantId, userId);
    const key = `${locale}|${userId}`;
    if (!rendered.has(key)) rendered.set(key, renderTemplate(event, locale, userId));
    return rendered.get(key)!;
  };
  const skip = notToldOf(event);

  // Dedup tracker: with the unique constraint dropped (per-user channel
  // routing), the same (userId, channel) tuple could otherwise be delivered
  // twice if two rules overlap. Set keeps each tuple to a single delivery
  // per event.
  const delivered = new Set<string>();
  // Each person's own switches and quiet hours (Step 0), read once per event.
  let hhmm: string | null = null;

  for (const pref of effective) {
    // Conditions filter - skip the pref if any condition fails.
    if (!evaluateConditions(pref.conditions, event.data)) continue;

    const spec = (pref.recipients ?? {}) as RecipientSpec;
    if (!spec || typeof spec !== "object" || !spec.type) continue;

    const channels: string[] = Array.isArray(pref.channels) ? pref.channels : ["email", "in_app"];
    const recipients = await resolveRecipients({
      tenantId: event.tenantId,
      departmentId: event.departmentId ?? pref.departmentId ?? undefined,
      spec,
    });
    if (recipients.length === 0) continue;
    const personal = await loadPersonal(recipients.map((u) => u.id), event.tenantId);
    hhmm ??= localTime(new Date(), await workspaceTimeZone(event.tenantId));

    // WhatsApp is personal, not a workspace rule's channel: added for everyone
    // the event reaches when it has a template; personalAllows decides.
    const withWhatsApp = wantsWhatsApp(event.type) && !channels.includes("whatsapp") ? [...channels, "whatsapp"] : channels;
    // Push is personal the same way (a phone the person registered): added
    // for the events that push, never offered on a workspace rule. An inbound
    // customer message is push only, whatever a rule would say.
    const withPersonal = ASSIGNEE_PUSH_ONLY.has(event.type)
      ? ["push"]
      : wantsPush(event.type) && !withWhatsApp.includes("push") ? [...withWhatsApp, "push"] : withWhatsApp;
    for (const user of recipients) {
      if (user.id === skip) continue;
      for (const channel of withPersonal) {
        const key = `${user.id}|${channel}`;
        if (delivered.has(key)) continue;
        if (!personalAllows(personal.get(user.id) ?? PERSONAL_DEFAULTS, channel, event, hhmm)) continue;
        delivered.add(key);
        await deliverChannel({
          channel,
          user,
          event,
          tpl: await tplFor(user.id),
          priority: pref.priority || "MEDIUM",
          whatsappPhone: personal.get(user.id)?.whatsappPhone ?? null,
        });
      }
    }
  }
}

/**
 * The workspace's enabled rules for an event. We OR (departmentId =
 * event.departmentId) OR (departmentId = NULL); department-scoped rows then
 * override tenant-default ones - the department row is more specific and the
 * operator clearly meant to override. No departmentId: tenant-default rows only.
 */
async function rulesFor(tenantId: string, eventType: string, departmentId?: string): Promise<any[]> {
  const where: any = { tenantId, eventType, enabled: true };
  if (departmentId) where.OR = [{ departmentId }, { departmentId: null }];
  else where.departmentId = null;
  const prefs: any[] = await (prisma as any).notificationPreference.findMany({ where });
  return prefs.some((p) => p.departmentId) ? prefs.filter((p) => p.departmentId) : prefs;
}

/**
 * A customer message in a conversation the TEAM has and nobody claimed
 * (handed over, or a person replied from the queue): EVERYONE in the
 * workspace who can read conversations - "if the chat isn't assigned, alert
 * everyone" (Omer, 2026-11-03). Not the department and not an escalation
 * rule's recipients: everyone, the department set or not. Push only (no rule
 * channels; push is added per person), and each person's push switch,
 * per-event switch and quiet hours still decide.
 */
function teamQueueRoutes(_event: SystemEvent): any[] {
  return [{ priority: "MEDIUM", conditions: null, channels: [] as string[], departmentId: null, recipients: { type: "conversation_readers" } as RecipientSpec }];
}

/**
 * Who hears of an event when the workspace set no rule for it: the person it
 * is about, else the workspace's admins. In-app always; email too for the
 * events below (Omer, 2026-10-12): the ones that need someone to act. Same
 * recipients as in-app, and each person's own switches and quiet hours still
 * decide (personalAllows). A workspace rule for the event replaces all of it.
 */
export const EMAIL_BY_DEFAULT: ReadonlySet<string> = new Set([
  "conversation.waiting",
  "tool.approval_required",
  "tool.action_failed",
  "integration.check_failed",
  "conversation.escalated",
  "conversation.assigned",
]);
/**
 * Push (mobile app, 2026-11-03), a PERSONAL channel like WhatsApp: not a
 * workspace rule's channel and not in DELIVERABLE_CHANNELS, but added for
 * everyone these events reach, by whichever route (processEvent,
 * withPersonal). The person's own push switch, per-event switch and quiet
 * hours decide. conversation.waiting pushes only while nobody is assigned
 * (skipPushForAssignedWaiting).
 */
export const PUSH_BY_DEFAULT: ReadonlySet<string> = new Set([
  "tool.approval_required",
  "conversation.escalated",
  "conversation.assigned",
  "conversation.waiting",
]);
/**
 * Push only (Omer, 2026-11-03): every inbound customer message in a
 * conversation people handle - to its assignee, or with nobody assigned, to
 * everyone who can read conversations (teamQueueRoutes). The emitter
 * (shared lib/notifications/inbound-push) already refuses one the bot handles.
 */
export const ASSIGNEE_PUSH_ONLY: ReadonlySet<string> = new Set(["message.inbound"]);
/** Whether this event is pushed to the phones of the people it reaches. */
export function wantsPush(type: string): boolean {
  return PUSH_BY_DEFAULT.has(type) || ASSIGNEE_PUSH_ONLY.has(type);
}
const ADMINS_FOR = new Set([
  "tool.approval_required", "tool.action_failed", "conversation.escalated", "integration.check_failed", "broadcast.completed",
  "refund.issued", "discount.applied", "meeting.scheduled",
  "invoice.paid", "payment.failed", "subscription.activated", "subscription.canceled", "subscription.past_due", "subscription.plan_changed",
  "subscription.resumed", "subscription.suspended", "subscription.trial_started", "credit.threshold", "credit.exhausted",
  "credit.auto_purchase_succeeded", "credit.auto_purchase_failed", "credit.auto_purchase_ceiling_reached",
]);
export function defaultRoute(event: SystemEvent): { recipients: RecipientSpec; channels: string[]; priority: string; conditions: null; departmentId: null } | null {
  const base = { priority: "MEDIUM", conditions: null, departmentId: null } as const;
  const channels = EMAIL_BY_DEFAULT.has(event.type) ? ["in_app", "email"] : ["in_app"];
  if (ASSIGNEE_PUSH_ONLY.has(event.type)) {
    // No rule channels at all: push is personal and added per recipient
    // (processEvent, withPersonal), so the assignee's phone is all it reaches.
    const userId = (event.data as any)?.assignedAgentId ?? event.metadata?.userId;
    return typeof userId === "string" && userId
      ? { ...base, channels: [], recipients: { type: "users", userIds: [userId] } as RecipientSpec }
      : null;
  }
  if (event.type === "conversation.waiting") {
    // The assignee, else the department's members (resolved by the sweeper);
    // with neither, the admins.
    const ids = Array.isArray((event.data as any)?.recipientUserIds) ? ((event.data as any).recipientUserIds as unknown[]).filter((x): x is string => typeof x === "string" && !!x) : [];
    return { ...base, channels, recipients: ids.length ? ({ type: "users", userIds: ids } as RecipientSpec) : ({ type: "tenant_owner" } as RecipientSpec) };
  }
  if (event.type === "conversation.assigned") {
    // The assignee only, never the admins.
    const userId = event.metadata?.userId;
    return userId ? { ...base, channels, recipients: { type: "users", userIds: [userId] } as RecipientSpec } : null;
  }
  if (ADMINS_FOR.has(event.type)) return { ...base, channels, recipients: { type: "tenant_owner" } as RecipientSpec };
  return null;
}

/**
 * The one person an event is NOT told to: whoever proposed a plan in Home or
 * the command bar is looking at it, and the answer already says it waits.
 */
export function notToldOf(event: SystemEvent): string | null {
  if (event.type !== "tool.approval_required") return null;
  const plan = (event.data as any)?.plan;
  const from = plan?.source;
  const who = plan?.requester?.userId;
  return (from === "home_assistant" || from === "command_bar") && typeof who === "string" && who ? who : null;
}

export const AUTOMATION_NOTICE = "automation.notify_team";

/**
 * In-app delivery of an automation's "Notify team": the chosen people, else
 * everyone in the chosen department, else the workspace admins. Every lookup
 * is tenant-scoped, so an id from another tenant reaches no one.
 */
export async function deliverAutomationNotice(event: SystemEvent): Promise<number> {
  const d = (event.data ?? {}) as Record<string, any>;
  const message = typeof d.message === "string" ? d.message.trim().slice(0, 1000) : "";
  if (!message) return 0;
  const userIds: string[] = Array.isArray(d.userIds) ? d.userIds.map(String).filter(Boolean) : [];
  const departmentId = typeof d.departmentId === "string" && d.departmentId ? d.departmentId : null;
  const users = new Map<string, ResolvedUser>();
  if (userIds.length) {
    for (const u of await resolveRecipients({ tenantId: event.tenantId, spec: { type: "users", userIds } as RecipientSpec })) users.set(u.id, u);
  }
  if (departmentId) {
    const members = await (prisma as any).departmentMember.findMany({
      where: { tenantId: event.tenantId, departmentId },
      include: { user: { select: { id: true, tenantId: true, email: true, name: true, notificationSoundEnabled: true, isActive: true } } },
    });
    for (const m of members) if (m.user?.isActive) users.set(m.user.id, m.user);
  }
  if (!userIds.length && !departmentId) {
    for (const u of await resolveRecipients({ tenantId: event.tenantId, spec: { type: "tenant_owner" } as RecipientSpec })) users.set(u.id, u);
  }
  const link = typeof d.conversationId === "string" && d.conversationId ? `/inbox?c=${encodeURIComponent(d.conversationId)}` : undefined;
  // The person's own in-app switch holds here too.
  const personal = await loadPersonal([...users.keys()], event.tenantId);
  for (const user of users.values()) {
    const p = personal.get(user.id) ?? PERSONAL_DEFAULTS;
    if (!p.inApp || p.events?.[event.type]?.inApp === false) continue;
    const title = (await localeForRecipient(event.tenantId, user.id)) === "he" ? "אוטומציה" : "Automation";
    await deliverChannel({ channel: "in_app", user, event, tpl: { title, body: message, ...(link ? { link } : {}) }, priority: "MEDIUM" });
  }
  return users.size;
}

/**
 * The channels this dispatcher can actually deliver.
 *
 * EXPORTED because anything that OFFERS a channel has to agree with what can
 * SEND one. The settings screen and the event catalogue read this rather than
 * carrying their own list - a second list is a second chance to offer a box
 * that does nothing, which is the defect this constant exists to prevent.
 *
 * Adding a channel means adding an arm in `deliverChannel` AND adding it here.
 * Adding it to only one is the failure either way round: here but not there
 * offers an undeliverable box, there but not here hides a working channel.
 */
export const DELIVERABLE_CHANNELS = ["in_app", "email"] as const;
export type DeliverableChannel = (typeof DELIVERABLE_CHANNELS)[number];

export function isDeliverableChannel(channel: string): channel is DeliverableChannel {
  return (DELIVERABLE_CHANNELS as readonly string[]).includes(channel);
}

/**
 * Write the fact that a configured channel could not be delivered.
 *
 * Never throws - a bookkeeping failure must not break the delivery of the
 * OTHER channels on the same preference. The console line is kept as well, at
 * warn rather than info, so it is visible while tailing.
 */
async function recordUndeliverable(opts: {
  channel: string;
  user: { id: string; tenantId: string; email?: string | null };
  event: { type: string; id?: string };
  tpl: { title: string; body: string };
}): Promise<void> {
  const { channel, user, event, tpl } = opts;
  const reason =
    `Channel "${channel}" is enabled on a notification preference but this ` +
    `deployment cannot deliver it, so nothing was sent. Deliverable channels: ` +
    `${DELIVERABLE_CHANNELS.join(", ")}.`;
  console.warn(`[notifications] UNDELIVERABLE channel="${channel}" event=${event.type} user=${user.id}: nothing sent`);
  try {
    await (prisma as any).notificationLog.create({
      data: {
        tenantId: user.tenantId,
        channel,
        type: event.type,
        recipient: user.email ?? user.id,
        subject: tpl.title,
        body: tpl.body,
        status: "failed",
        error: reason,
        metadata: { eventId: event.id, undeliverableChannel: true },
      },
    });
  } catch (err: any) {
    console.warn("[notifications] could not record undeliverable delivery:", err?.message);
  }
}

async function deliverChannel(opts: {
  channel: string;
  user: ResolvedUser;
  event: SystemEvent;
  tpl: { title: string; body: string; link?: string };
  priority: string;
  whatsappPhone?: string | null;
}): Promise<void> {
  const { channel, user, event, tpl, priority } = opts;
  try {
    if (channel === "in_app") {
      // Persist + publish on the shared event bus inline. Cheap and
      // synchronous - the row is the dashboard's source of truth.
      await createInAppNotification({
        tenantId: user.tenantId,
        userId: user.id,
        eventType: event.type,
        title: tpl.title,
        body: tpl.body,
        link: tpl.link,
        priority: priority as any,
        // What it is about (an approval request, a conversation...), typed:
        // without it every row was "none", and nothing could be resolved later.
        metadata: { ...(event.data ?? {}), ...(event.metadata ?? {}) },
      });
    } else if (channel === "whatsapp") {
      // A personal channel (whatsapp-notice.service): the person's confirmed number.
      await deliverWhatsAppNotice({ user, event, phone: opts.whatsappPhone });
    } else if (channel === "email") {
      const opts: JobsOptions = { ...DEFAULT_NOTIF_JOB_OPTS };
      await getNotificationsEmailQueue().add(
        "send-email",
        {
          tenantId: user.tenantId,
          userId: user.id,
          to: user.email,
          eventType: event.type,
          eventId: event.id,
          priority,
          subject: tpl.title,
          // A notice whose title says it all has an empty body; an email still needs one.
          body: tpl.body || tpl.title,
          link: tpl.link,
        },
        opts,
      );
    } else if (channel === "push") {
      // ── conversation.waiting guard ──────────────────────────────────────
      // "A conversation is waiting" is pushed only while NOBODY owns it: once
      // someone is assigned, the assignee hears each customer message through
      // message.inbound instead, and a waiting push on top would be the same
      // news twice. Keyed on the waiting alert's own payload
      // (waiting-alert.service, data.assignedAgentId). Its in-app row and
      // email are untouched.
      if (skipPushForAssignedWaiting(event)) return;
      // Not configured (said once, by the sender) and no registered phone are
      // the normal state for most people, not failures, so unlike the
      // undeliverable arm below neither writes a row: every web-only user
      // would write one per event. Each actual send is logged per device.
      await sendPushToUser({ user, event, tpl, priority });
    } else {
      // ── A channel nobody can deliver ────────────────────────────────────
      //
      // This used to be `console.info(... not implemented yet - skipped)` and
      // nothing else, which made an undeliverable channel SUCCEED silently: an
      // admin ticks a box, the preference saves, the screen shows it on, and
      // no message is ever sent. No error, no row, nothing they would ever
      // look at. A control that reports success while the thing it controls
      // does not happen is the worst shape of defect this codebase has - it is
      // wrong in the REASSURING direction, so nobody goes looking.
      //
      // It is recorded as a FAILED delivery rather than logged, because a log
      // line rotates and a failed-delivery row is the thing an operator can
      // find afterwards. Same table the email sender writes to, so
      // undeliverable channels appear beside real send failures rather than in
      // a separate place nobody checks.
      //
      // Deliberately one row per attempted delivery, exactly as a failed email
      // produces one: the volume IS the signal. A preference ticking a channel
      // we cannot send on should look expensive.
      await recordUndeliverable({ channel, user, event, tpl });
    }
  } catch (err: any) {
    console.warn(`[notifications.deliver] channel=${channel} userId=${user.id} failed:`, err?.message);
  }
}

/** conversation.waiting is pushed only to a conversation nobody is assigned to. */
export function skipPushForAssignedWaiting(event: { type: string; data?: Record<string, unknown> }): boolean {
  return (event.type as string) === "conversation.waiting" && !!(event.data as any)?.assignedAgentId;
}
