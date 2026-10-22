import {
  shadowedRuleIds,
  undeliverableChannels,
  type NotificationRule,
} from '@/api/contracts/notification-rules';
import type { Department, Member } from '@/api/contracts/people';

import { NOTIFIABLE_EVENTS, UNFIRING_EVENTS } from './events';

/**
 * Turning stored rules into what the screen says about them.
 *
 * Pure, and separate from the component, because almost everything worth
 * getting right here is a judgement about the data rather than about markup -
 * whether an event can fire, whether a channel is delivered, whether one rule
 * silently displaces another. This tenant has no rules at all, so a capture
 * cannot exercise any of it and these are the only tests that can.
 */

/**
 * What the platform will do with this rule's event.
 *
 *   `known`    - in the vocabulary; something raises it
 *   `unfiring` - a real, templated type that **nothing emits**
 *   `unknown`  - not a type this platform declares at all, almost certainly a
 *                typo, and the route accepted it because it validates
 *                `eventType` against nothing
 *
 * The last two are different sentences on screen. "GOTCHA never raises this"
 * and "GOTCHA has never heard of this" have different causes and different
 * remedies, and collapsing them would tell an admin to go looking in the
 * wrong place.
 */
export type EventStatus = 'known' | 'unfiring' | 'unknown';

const KNOWN = new Set(NOTIFIABLE_EVENTS.map((e) => e.type));
const UNFIRING = new Set(UNFIRING_EVENTS);

export function eventStatus(eventType: string): EventStatus {
  if (KNOWN.has(eventType)) return 'known';
  if (UNFIRING.has(eventType)) return 'unfiring';
  return 'unknown';
}

export interface RuleView {
  readonly id: string;
  readonly enabled: boolean;
  /** `null` is tenant-wide - every team. */
  readonly departmentId: string | null;
  /** Resolved team name, or `null` when tenant-wide or unresolvable. */
  readonly departmentName: string | null;
  /** True when scoped to a team whose name could not be read. */
  readonly departmentMissing: boolean;
  readonly recipientType: NotificationRule['recipients']['type'];
  /** Named people, for `type: 'users'` only. Ids that resolve to nothing are dropped. */
  readonly recipientNames: readonly string[];
  /** How many named recipients could not be resolved to a person. */
  readonly unresolvedRecipients: number;
  readonly channels: readonly string[];
  /** Channels the dispatcher logs and drops. */
  readonly undeliverable: readonly string[];
  /** Nothing this rule asks for can be delivered. */
  readonly deliversNothing: boolean;
  /** A department rule for the same event displaces this tenant-wide one. */
  readonly shadowed: boolean;
  /** Rendered conditions, already flattened to strings. */
  readonly conditions: readonly string[];
}

export interface EventGroup {
  readonly eventType: string;
  readonly status: EventStatus;
  readonly rules: readonly RuleView[];
}

function personName(member: Member): string {
  return member.name?.trim() || member.email?.trim() || '';
}

function describeConditions(conditions: NotificationRule['conditions']): readonly string[] {
  if (conditions === null) return [];
  // The route accepts a bare string as a "CEL-lite placeholder" and stores it
  // unparsed. Nothing evaluates it into parts, so it is shown as written.
  if (typeof conditions === 'string') {
    const trimmed = conditions.trim();
    return trimmed ? [trimmed] : [];
  }
  return conditions.map((c) =>
    c.value === undefined ? `${c.field} ${c.op}` : `${c.field} ${c.op} ${String(c.value)}`,
  );
}

export function toRuleView(
  rule: NotificationRule,
  context: {
    readonly departments: readonly Department[] | null;
    readonly members: readonly Member[] | null;
    readonly shadowed: ReadonlySet<string>;
  },
): RuleView {
  const department =
    rule.departmentId === null
      ? null
      : (context.departments?.find((d) => d.id === rule.departmentId) ?? null);

  const ids = rule.recipients.type === 'users' ? (rule.recipients.userIds ?? []) : [];
  const names = ids
    .map((id) => context.members?.find((m) => m.id === id))
    .map((m) => (m ? personName(m) : ''))
    .filter((name) => name.length > 0);

  const undeliverable = undeliverableChannels(rule);

  return {
    id: rule.id,
    enabled: rule.enabled,
    departmentId: rule.departmentId,
    departmentName: department?.name ?? null,
    // A rule scoped to a team we cannot name is not a tenant-wide rule, and
    // must never be drawn as one - that would overstate its reach.
    departmentMissing: rule.departmentId !== null && department === null,
    recipientType: rule.recipients.type,
    recipientNames: names,
    unresolvedRecipients: ids.length - names.length,
    channels: rule.channels,
    undeliverable,
    deliversNothing: rule.channels.length > 0 && undeliverable.length === rule.channels.length,
    shadowed: context.shadowed.has(rule.id),
    conditions: describeConditions(rule.conditions),
  };
}

/**
 * Rules grouped by the event they answer to.
 *
 * The event is the grouping and not an axis, because a `(tenant, department,
 * event)` triple holds **several** rules and all of them apply - the two
 * partial unique indexes were dropped on purpose. A grid of one cell per
 * event would have to pick one of N to display, and would therefore lie about
 * what is configured.
 *
 * Vocabulary order first, so the list reads in the same order as the day-one
 * state that preceded it. Anything outside the vocabulary sorts last: those
 * are the rows that need attention and the ones an admin did not mean to make.
 */
export function groupRulesByEvent(
  rules: readonly NotificationRule[],
  context: {
    readonly departments: readonly Department[] | null;
    readonly members: readonly Member[] | null;
  },
): readonly EventGroup[] {
  const shadowed = shadowedRuleIds(rules);
  const order = new Map(NOTIFIABLE_EVENTS.map((e, i) => [e.type, i]));

  const byEvent = new Map<string, NotificationRule[]>();
  for (const rule of rules) {
    const existing = byEvent.get(rule.eventType);
    if (existing) existing.push(rule);
    else byEvent.set(rule.eventType, [rule]);
  }

  return [...byEvent.entries()]
    .sort(([a], [b]) => {
      const ai = order.get(a) ?? Number.MAX_SAFE_INTEGER;
      const bi = order.get(b) ?? Number.MAX_SAFE_INTEGER;
      return ai === bi ? a.localeCompare(b) : ai - bi;
    })
    .map(([eventType, eventRules]) => ({
      eventType,
      status: eventStatus(eventType),
      rules: eventRules.map((rule) => toRuleView(rule, { ...context, shadowed })),
    }));
}
