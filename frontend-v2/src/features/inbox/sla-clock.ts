import type { ConversationRow } from '@/api/contracts/inbox';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THE RESPONSE TARGET, ON THE ROWS THAT A PERSON OWES AN ANSWER (W2)
 * ════════════════════════════════════════════════════════════════════════════
 * Omer (2026-10-12): "it already worked in the old frontend: if the SLA is
 * passed, a blinking red dot". The legacy list's rule, ported
 * (frontend ConversationList.tsx, `SlaChip` and the status dot):
 *
 *   minutes   the department's own target when it has one, else the workspace's
 *   since     the row's `waitingSince` (Backend 558f64a5): the FIRST customer
 *             message after our last reply. Legacy timed from the LAST
 *             message, so three messages restarted the clock three times and
 *             the wait was under-reported. A server without the field: the
 *             last message, else when the conversation started
 *   ≥ 100%    late - a red dot that pulses, and "Past SLA"
 *   ≥ warn %  a quiet amber chip with the minutes left
 *
 * ── WHO IS TIMED ──
 * Only a customer waiting on us:
 *   - not a closed conversation;
 *   - not one GOTCHA or a flow is CARRYING ("מנוהל ע״י GOTCHA") - nobody is
 *     late for a conversation an employee is already answering (legacy, too).
 *     ⚠ Carrying is the route's own three-part rule (conversation.service.ts,
 *     `automatedOnly`): `handledBy` ai_agent or flow AND not handed over AND
 *     nobody assigned. `handledBy` alone is not it - it stays `ai_agent`
 *     after a person is assigned, and timing on it alone left every assigned
 *     conversation unmarked (dev, 2026-10-12: Omer's row, 22 hours waiting);
 *   - not one whose last message was OURS (supervisor, 2026-10-12): legacy
 *     timed it anyway, and a conversation answered a minute ago went red.
 *
 * ── AND WHAT IS NOT KNOWN DRAWS NOTHING ──
 * No target read (a 403 for anyone but an Owner, a failed read, switched
 * off), or a department whose own target could not be read: no mark. A row
 * with no mark must never be a claim that it is on time.
 */

/** What the inbox read: the workspace's target, and each department's on screen. */
export interface SlaClock {
  readonly minutes: number;
  /** The percentage at which the amber chip starts; `null` - none, only late. */
  readonly warningPercent: number | null;
  /**
   * Per department on this page: its own minutes, `'workspace'` when it has
   * no override, `'unread'` when its read failed.
   */
  readonly departments: Readonly<Record<string, number | 'workspace' | 'unread'>>;
}

export interface SlaTarget {
  /** ISO: when the customer started waiting. */
  readonly since: string;
  readonly minutes: number;
  readonly warningPercent: number | null;
}

export type SlaState =
  | { readonly kind: 'none' }
  | { readonly kind: 'warning'; readonly minutesLeft: number }
  | { readonly kind: 'late' };

/** How often a mark looks at the clock again - no refetch of the list. */
export const SLA_TICK_MS = 30_000;

type Timed = Pick<
  ConversationRow,
  | 'status'
  | 'handledBy'
  | 'isHandedOver'
  | 'assignedAgentId'
  | 'lastMessageDirection'
  | 'lastMessageAt'
  | 'createdAt'
  | 'departmentId'
  | 'waitingSince'
>;

/** The target this row is held to, or `null` when it is not timed. */
export function slaTargetFor(row: Timed, clock: SlaClock | null): SlaTarget | null {
  if (clock === null) return null;
  if (row.status === 'CLOSED') return null;
  const carried =
    (row.handledBy === 'ai_agent' || row.handledBy === 'flow') &&
    !row.isHandedOver &&
    row.assignedAgentId === null;
  if (carried) return null;
  // `waitingSince` null: nothing came in after our last reply - nobody waits.
  if (row.waitingSince === null) return null;
  // An older server: the customer spoke last, timed from the last message.
  if (row.waitingSince === undefined && row.lastMessageDirection === 'OUTBOUND') return null;
  const since = row.waitingSince ?? row.lastMessageAt ?? row.createdAt;
  if (since === null || !Number.isFinite(Date.parse(since))) return null;
  const own = row.departmentId === null ? undefined : clock.departments[row.departmentId];
  if (own === 'unread') return null;
  return {
    since,
    minutes: typeof own === 'number' ? own : clock.minutes,
    warningPercent: clock.warningPercent,
  };
}

/** Where the row stands against its target at `now` (ms). */
export function slaState(target: SlaTarget, now: number): SlaState {
  const elapsed = (now - Date.parse(target.since)) / 60_000;
  const percent = (elapsed / target.minutes) * 100;
  if (percent >= 100) return { kind: 'late' };
  if (target.warningPercent !== null && percent >= target.warningPercent) {
    return { kind: 'warning', minutesLeft: Math.max(1, Math.ceil(target.minutes - elapsed)) };
  }
  return { kind: 'none' };
}
