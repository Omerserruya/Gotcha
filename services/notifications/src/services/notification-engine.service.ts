/**
 * Notification engine — fan-out logic.
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
import { createInAppNotification } from "./in-app.service";
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
  // approximate dedup, not equality — small key-order drift is acceptable.
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
    // SET NX EX — atomic "claim if absent". Returns "OK" on first claim,
    // null when the dedup key already exists.
    const ok = await (redis as any).set(key, "1", "EX", DEDUP_TTL_SECONDS, "NX");
    return ok === "OK" || ok === true;
  } catch (err: any) {
    // If Redis is down, fail open — better to deliver duplicates than to
    // silently drop a high-value notification.
    console.warn("[notifications.dedup] redis check failed:", err?.message);
    return true;
  }
}

// ── Main entry ────────────────────────────────────────────

export async function processEvent(event: SystemEvent): Promise<void> {
  // 1. Load matching preferences. We OR (departmentId = event.departmentId)
  //    OR (departmentId = NULL) and post-filter to prefer department-scoped
  //    rows. If departmentId is undefined we only match tenant-default rows.
  const where: any = {
    tenantId: event.tenantId,
    eventType: event.type,
    enabled: true,
  };
  if (event.departmentId) {
    where.OR = [{ departmentId: event.departmentId }, { departmentId: null }];
  } else {
    where.departmentId = null;
  }

  const prefs: any[] = await (prisma as any).notificationPreference.findMany({ where });
  if (prefs.length === 0) return;

  // Department-scoped preferences override tenant-default ones for the same
  // event type. If both exist, drop the tenant-default — the department row
  // is more specific and the operator clearly meant to override.
  const hasDeptScoped = prefs.some((p) => p.departmentId);
  const effective = hasDeptScoped ? prefs.filter((p) => p.departmentId) : prefs;

  // 2. Dedup once per event payload — even if multiple prefs would match,
  //    we don't want to re-fire identical bursts.
  const ok = await shouldDeliver(event.tenantId, event.type, event.data);
  if (!ok) return;

  // 3. Render template once (pure function of the event).
  const tpl = renderTemplate(event);

  // Dedup tracker: with the unique constraint dropped (per-user channel
  // routing), the same (userId, channel) tuple could otherwise be delivered
  // twice if two rules overlap. Set keeps each tuple to a single delivery
  // per event.
  const delivered = new Set<string>();

  for (const pref of effective) {
    // Conditions filter — skip the pref if any condition fails.
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

    for (const user of recipients) {
      for (const channel of channels) {
        const key = `${user.id}|${channel}`;
        if (delivered.has(key)) continue;
        delivered.add(key);
        await deliverChannel({
          channel,
          user,
          event,
          tpl,
          priority: pref.priority || "MEDIUM",
        });
      }
    }
  }
}

async function deliverChannel(opts: {
  channel: string;
  user: ResolvedUser;
  event: SystemEvent;
  tpl: { title: string; body: string; link?: string };
  priority: string;
}): Promise<void> {
  const { channel, user, event, tpl, priority } = opts;
  try {
    if (channel === "in_app") {
      // Persist + publish on the shared event bus inline. Cheap and
      // synchronous — the row is the dashboard's source of truth.
      await createInAppNotification({
        tenantId: user.tenantId,
        userId: user.id,
        eventType: event.type,
        title: tpl.title,
        body: tpl.body,
        link: tpl.link,
        priority: priority as any,
      });
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
          body: tpl.body,
          link: tpl.link,
        },
        opts,
      );
    } else {
      // Unknown channel = forward-compat. Adding "slack"/"sms" later is a
      // single switch arm here, no schema change. We log and skip.
      console.info(`[notifications] channel "${channel}" not implemented yet — skipped`);
    }
  } catch (err: any) {
    console.warn(`[notifications.deliver] channel=${channel} userId=${user.id} failed:`, err?.message);
  }
}
