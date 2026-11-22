/**
 * "A customer is waiting for a reply" (Omer, 2026-11-02).
 *
 * The clock starts at the customer's FIRST inbound message that has had no
 * reply; later customer messages do not move it. A reply is any outbound from
 * a person or an AI employee: not a broadcast, a scheduled send, the system's
 * own lines ("System": auto-greeting, outside-hours text, automation sends),
 * the slow-turn holding line or the approval bridge ack. A reply ends the
 * waiting period; the next unanswered message starts a new one.
 *
 * When the period passes the workspace's SLA minutes (the department's
 * override when it has one), ONE alert per period goes to the assignee, else
 * the department's members, else the admins (a notification rule for the
 * event wins, as for every event). Only when that SLA is enabled. Closed and
 * archived conversations, and imported history, are skipped.
 *
 * A minute sweeper under a Redis lock; one alert per period by a Redis key
 * that outlives restarts (conversation id + the period's start).
 */
import { prisma, getRedis, readDurableSetting, withCrossTenantAccess } from "@chatcenter/shared";
import { tryEmit } from "./event-emitter.service";

export const WAITING_SWEEP_MS = 60_000;
const LOCK_KEY = "notify:waiting-sweep:lock";
const DEDUPE_TTL_S = 14 * 24 * 3600;
/** Conversations active in this window are considered; older ones are not "waiting", they are abandoned. */
const ACTIVE_WINDOW_MS = 3 * 24 * 3600 * 1000;

export interface WaitingRow {
  id: string;
  tenantId: string;
  departmentId: string | null;
  assignedAgentId: string | null;
  channel: string;
  waitingSince: Date;
}

export interface SlaSetting { enabled: boolean; slaMinutes: number }

/** Conversations with a customer message nobody has answered for at least a minute. */
/** The hidden labels written into findWaiting's SQL; a test holds them equal to AUTOMATION_HIDDEN_CATEGORIES. */
export const WAITING_HIDDEN_SQL_CATEGORIES = ["personal", "notice", "marketing", "auto_reply", "internal"] as const;

export async function findWaiting(now: Date): Promise<WaitingRow[]> {
  const since = new Date(now.getTime() - ACTIVE_WINDOW_MS);
  const cutoff = new Date(now.getTime() - 60_000);
  return withCrossTenantAccess(() => (prisma as any).$queryRaw`
    SELECT c.id, c.tenant_id AS "tenantId", c.department_id AS "departmentId",
           c.assigned_agent_id AS "assignedAgentId", c.channel::text AS channel,
           w.waiting_since AS "waitingSince"
    FROM conversations c
    CROSS JOIN LATERAL (
      SELECT min(m.created_at) AS waiting_since
      FROM messages m
      WHERE m.conversation_id = c.id AND m.direction = 'INBOUND' AND m.origin = 'LIVE'
        AND m.created_at > COALESCE((
          SELECT max(o.created_at) FROM messages o
          WHERE o.conversation_id = c.id AND o.direction = 'OUTBOUND'
            AND o.broadcast_id IS NULL AND o.scheduled_message_id IS NULL
            AND COALESCE(o.sender_name, '') NOT IN ('System', 'Broadcast', 'Voice Flow')
            AND COALESCE(o.metadata->>'kind', '') NOT IN ('holding', 'bridge_ack_for_approval')
        ), 'epoch'::timestamp)
    ) w
    WHERE c.status <> 'CLOSED' AND c.archived_at IS NULL AND c.origin = 'LIVE'
      AND c.last_message_at > ${since}
      -- Not a hidden conversation (packages/shared relevance-hidden.ts, the same rule; WAITING_HIDDEN_SQL_CATEGORIES).
      AND NOT (
        COALESCE(c.relevance_category, '') IN ('personal', 'notice', 'marketing', 'auto_reply', 'internal')
        AND (
          c.relevance_overridden_by IS NOT NULL
          OR (
            COALESCE(c.relevance_confidence, 0)::float8 >= 0.7
            AND NOT EXISTS (SELECT 1 FROM channel_accounts ca WHERE ca.id = c.channel_account_id AND ca.relevance_filter_enabled = false)
          )
        )
      )
      AND w.waiting_since IS NOT NULL AND w.waiting_since < ${cutoff}
    LIMIT 2000
  `) as Promise<WaitingRow[]>;
}

/** The SLA that applies: the department's own when it has one, else the workspace's; null when none is stored. */
export function parseSla(raw: string | null): SlaSetting | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    const minutes = Number(v?.slaMinutes);
    return { enabled: v?.enabled === true, slaMinutes: Number.isFinite(minutes) && minutes >= 1 ? minutes : 30 };
  } catch {
    return null;
  }
}

export async function slaFor(tenantId: string, departmentId: string | null): Promise<SlaSetting | null> {
  if (departmentId) {
    const own = parseSla(await readDurableSetting(tenantId, `department:${departmentId}:sla`).catch(() => null));
    if (own) return own;
  }
  return parseSla(await readDurableSetting(tenantId, "sla").catch(() => null));
}

/** Waited past the SLA, with the SLA on. */
export function isOverdue(row: Pick<WaitingRow, "waitingSince">, sla: SlaSetting | null, now: Date): boolean {
  if (!sla?.enabled) return false;
  return now.getTime() - new Date(row.waitingSince).getTime() >= sla.slaMinutes * 60_000;
}

/** The assignee, else the department's members; empty means "the admins" (defaultRoute). */
export async function recipientsFor(row: Pick<WaitingRow, "tenantId" | "assignedAgentId" | "departmentId">): Promise<string[]> {
  if (row.assignedAgentId) return [row.assignedAgentId];
  if (!row.departmentId) return [];
  const members = await withCrossTenantAccess(() => (prisma as any).departmentMember.findMany({
    where: { tenantId: row.tenantId, departmentId: row.departmentId, user: { isActive: true } },
    select: { userId: true },
  })).catch(() => [] as Array<{ userId: string }>);
  return [...new Set((members as Array<{ userId: string }>).map((m) => m.userId))];
}

export const dedupeKey = (row: Pick<WaitingRow, "id" | "waitingSince">) =>
  `notify:waiting:${row.id}:${new Date(row.waitingSince).getTime()}`;

/** One pass. Returns how many alerts it raised. */
export async function sweepWaiting(now: Date = new Date(), find: (now: Date) => Promise<WaitingRow[]> = findWaiting): Promise<number> {
  const redis = getRedis();
  if ((await redis.set(LOCK_KEY, "1", "EX", 55, "NX")) !== "OK") return 0;
  const rows = await find(now);
  const slaCache = new Map<string, SlaSetting | null>();
  let raised = 0;
  for (const row of rows) {
    const k = `${row.tenantId}:${row.departmentId ?? ""}`;
    if (!slaCache.has(k)) slaCache.set(k, await slaFor(row.tenantId, row.departmentId));
    const sla = slaCache.get(k) ?? null;
    if (!isOverdue(row, sla, now)) continue;
    // One alert per waiting period, across restarts.
    if ((await redis.set(dedupeKey(row), "1", "EX", DEDUPE_TTL_S, "NX")) !== "OK") continue;
    const minutes = Math.floor((now.getTime() - new Date(row.waitingSince).getTime()) / 60_000);
    tryEmit({
      type: "conversation.waiting",
      tenantId: row.tenantId,
      departmentId: row.departmentId ?? undefined,
      data: {
        conversationId: row.id,
        channel: row.channel,
        waitingSince: new Date(row.waitingSince).toISOString(),
        minutes,
        assignedAgentId: row.assignedAgentId,
        departmentId: row.departmentId,
        recipientUserIds: await recipientsFor(row),
      },
      metadata: { conversationId: row.id },
    });
    raised++;
  }
  if (raised) console.log(`[notifications] waiting sweep: ${raised} alert(s)`);
  return raised;
}

let timer: NodeJS.Timeout | null = null;
export function startWaitingSweeper(): void {
  if (timer) return;
  timer = setInterval(() => {
    void sweepWaiting().catch((err) => console.warn("[notifications] waiting sweep failed:", err?.message));
  }, WAITING_SWEEP_MS);
  timer.unref();
}
