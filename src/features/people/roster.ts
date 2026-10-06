import type { AiEmployee, Member } from '@/api/contracts/people';
import type { AgentPresence, PresenceState } from '@/api/contracts/presence';

/**
 * The merge behind *"humans and AI employees in one list"*.
 *
 * They are one list and three resources. This is where that becomes true, and
 * it is deliberately a pure function of what the three reads returned: no
 * fetching, no translation, no formatting. The component decides how a row
 * reads in Hebrew; this decides what a row IS.
 *
 * Nothing here invents a value. A count that was not served stays `null` and
 * the column renders nothing, because "no open conversations" and "we were not
 * told" are different facts and only one of them is reassuring.
 */

export type RosterKind = 'person' | 'ai';

export interface RosterRow {
  /** Stable across the two collections, whose ids could otherwise collide. */
  readonly key: string;
  readonly kind: RosterKind;
  readonly id: string;
  /** Never empty. Falls back to the email's local part, then to the id. */
  readonly name: string;
  readonly email: string | null;
  readonly initials: string;
  /**
   * What this row may do - the assigned role's name.
   *
   * Never a money limit. The policy engine scopes amounts per action kind and
   * tenant-wide, with no notion of a subject, so a per-person figure is not
   * something the backend declined to send: it is something it cannot say.
   */
  readonly canDo: string | null;
  /** Team names. Someone may belong to several; an AI to at most one. */
  readonly teams: readonly string[];
  /** Assigned and not CLOSED. `null` = not served, never coerced to 0. */
  readonly openConversations: number | null;
  /** A person's presence. `null` for AI, which has no presence concept. */
  readonly presence: PresenceState | null;
  /** When an away window ends, ISO. Drives "away till 11:00". */
  readonly awayUntil: string | null;
  /**
   * Deactivated person, or a paused/draft AI employee.
   *
   * One flag for two underlying shapes because the consequence is identical:
   * this row is not answering anyone right now.
   */
  readonly dormant: boolean;
}

/** `Maya Levi` → `ML`; `Maya` → `MA`; `מאיה לוי` → `מל`. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) {
    // Two letters from a single-word name reads as an avatar; one reads as a
    // truncation. `Array.from` so a surrogate pair is not split in half.
    return Array.from(parts[0]!).slice(0, 2).join('').toUpperCase();
  }
  const first = Array.from(parts[0]!)[0] ?? '';
  const last = Array.from(parts[parts.length - 1]!)[0] ?? '';
  return (first + last).toUpperCase();
}

function displayName(
  name: string | null | undefined,
  email: string | null | undefined,
  id: string,
) {
  const trimmed = name?.trim();
  if (trimmed) return trimmed;
  // A person invited but not yet set up often has no name. The email's local
  // part is what a colleague would recognise; the id is a last resort that at
  // least stays stable between renders.
  const local = email?.split('@')[0]?.trim();
  return local || id;
}

function personRow(member: Member, presence: AgentPresence | undefined): RosterRow {
  const name = displayName(member.name, member.email, member.id);
  return {
    key: `person:${member.id}`,
    kind: 'person',
    id: member.id,
    name,
    email: member.email ?? null,
    initials: initialsOf(name),
    // `roleName` is the assigned built-in role. `legacyRole` is the old enum,
    // used only when no role has been assigned - it is a coarser answer to the
    // same question, not a different one.
    canDo: member.roleName ?? member.legacyRole ?? null,
    teams: member.departments
      .map((d) => d.departmentName)
      .filter((n): n is string => typeof n === 'string' && n.length > 0),
    openConversations: member.openConversations ?? null,
    presence: presence?.status ?? null,
    awayUntil: presence?.awayUntil ?? null,
    dormant: !member.isActive,
  };
}

function aiRow(ai: AiEmployee): RosterRow {
  return {
    key: `ai:${ai.id}`,
    kind: 'ai',
    id: ai.id,
    name: ai.name,
    email: null,
    initials: initialsOf(ai.name),
    // An AI employee's capability lives in its tool grants, which is a
    // separate call per employee. The row shows its ROLE, which is served with
    // the list; the design's "answers, refunds up to ₪100" is the money clause
    // that does not exist.
    canDo: ai.role || null,
    teams: ai.departmentName ? [ai.departmentName] : [],
    openConversations: ai.openConversations ?? null,
    presence: null,
    awayUntil: null,
    dormant: ai.status !== 'ACTIVE',
  };
}

/**
 * People first, then AI employees; within each, working before dormant, then
 * by name.
 *
 * **Grouped rather than interleaved, deliberately.** Sorting the two kinds
 * together by name would scatter them, and they answer different questions: a
 * person is who you ask, an AI employee is what is running. Their controls
 * differ too - you deactivate a colleague and you pause an employee - so a
 * paused AI sitting between two colleagues would put unlike rows side by side
 * for no reason other than their initials.
 *
 * Dormant last because someone deactivated, or an employee paused, is not who
 * the reader came to find.
 *
 * Name comparison is locale-aware: Hebrew names must sort in Hebrew, and
 * `<` on strings would order them by code point.
 */
export function buildRoster(
  members: readonly Member[],
  aiEmployees: readonly AiEmployee[],
  presence: readonly AgentPresence[],
  locale: string,
): RosterRow[] {
  const byAgent = new Map(presence.map((p) => [p.agentId, p]));
  const collator = new Intl.Collator(locale, { sensitivity: 'base', numeric: true });

  const order = (rows: RosterRow[]) =>
    rows.sort((a, b) => {
      if (a.dormant !== b.dormant) return a.dormant ? 1 : -1;
      return collator.compare(a.name, b.name);
    });

  return [
    ...order(members.map((m) => personRow(m, byAgent.get(m.id)))),
    ...order(aiEmployees.map(aiRow)),
  ];
}
