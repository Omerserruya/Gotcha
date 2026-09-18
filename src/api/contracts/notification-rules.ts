import { z } from 'zod';

/**
 * Settings · Notifications — the tenant's notification rules (screen 15).
 *
 * Shapes read from `services/notifications/src/routes/
 * notification-preferences-admin.ts` and the dispatcher that consumes them,
 * `services/notifications/src/services/notification-engine.service.ts`.
 *
 * A rule says *"when X happens, tell these people on these channels"*. It is
 * **not** a matrix cell. The two partial unique indexes on
 * `(tenant, department, event)` were created and then dropped by
 * `20260507400000_notification_pref_allow_multiple`, deliberately, so that one
 * event can carry several rules with different recipients and channels and all
 * of them apply. The Prisma model's comment still claims the uniqueness — it
 * is stale by one migration, and reading the model without the migrations
 * gives you the opposite of the truth.
 *
 * ── THREE THINGS THE ROUTE ACCEPTS AND THE PRODUCT DOES NOT DO ──
 * Each is a closed set here, and each gap is a function below rather than a
 * comment, because the screen is the only thing standing between an admin and
 * a rule that silently does nothing.
 *
 *  1. **`eventType` is validated against no list at all** — `POST` requires
 *     only a non-empty string (`:105`) and `PATCH` does not even trim (`:180`).
 *     Every other field in the payload has a closed set behind it. So the API
 *     will never refuse a row this screen draws; it will also happily store
 *     `conversaton.escalated`, answer `201`, list it as enabled, and match
 *     nothing forever. **The frontend is the only validation that exists.**
 *  2. **Five channels are accepted, two are delivered.** `slack`, `sms` and
 *     `webhook` pass the route's validator and reach an else branch that logs
 *     `not implemented yet - skipped` and returns (`engine:227`).
 *  3. **`priority` is consumed by nothing.** Validated, stored on the in-app
 *     row, carried in the email job payload, and read by no ordering, routing,
 *     rate or display anywhere. It is not offered as a control.
 *
 * ── AND ONE INTERACTION BETWEEN RULES ──
 * `engine:138` — if any department-scoped rule matches an event, **every
 * tenant-wide rule for that event is dropped**, not merged. Both rows read as
 * enabled in any list of them. See `shadowedRuleIds`.
 *
 * ── WRITES, WHEN THEY COME ──
 * The route answers **two different error shapes at the same status on the
 * same verb**: `{ error: "eventType is required" }` from the required-field
 * checks, and `{ error: { field, message } }` from `validateRecipients`,
 * `validateChannels`, `validatePriority` and `validateConditions`. Rendering
 * `String(body.error)` gives `[object Object]` for four of the five. Nothing
 * here parses errors yet because nothing here writes yet; this note exists so
 * that is discovered from a contract rather than from a screenshot.
 */

/** Stored and validated. Consumed by nothing — never offered as a control. */
export const RULE_PRIORITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;
export type RulePriority = (typeof RULE_PRIORITIES)[number];

/** What the route's `validateChannels` lets through. */
export const ACCEPTED_CHANNELS = ['email', 'in_app', 'slack', 'sms', 'webhook'] as const;

/** What `deliverChannel` actually sends. The other three are logged and dropped. */
export const DELIVERED_CHANNELS = ['email', 'in_app'] as const;
export type DeliveredChannel = (typeof DELIVERED_CHANNELS)[number];

/** All three genuinely resolve in `recipient-resolver.service.ts:45/52/82`. */
export const RECIPIENT_TYPES = ['tenant_owner', 'department_manager', 'users'] as const;
export type RecipientType = (typeof RECIPIENT_TYPES)[number];

export const CONDITION_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'contains'] as const;

const conditionSchema = z.object({
  field: z.string().min(1),
  op: z.enum(CONDITION_OPS),
  value: z.unknown().optional(),
});

const recipientsSchema = z.object({
  type: z.enum(RECIPIENT_TYPES),
  /** Required by the route when `type === 'users'`, absent otherwise. */
  userIds: z.array(z.string()).optional(),
});

/**
 * One rule.
 *
 * `object`, not `looseObject`: the row comes straight off Prisma and carries
 * `tenantId`, `createdAt` and `updatedAt` that no part of this screen needs.
 * Stripping them is the point — nothing unnamed crosses the boundary.
 *
 * `channels` is `string[]` and not an enum on purpose. The stored value is
 * whatever passed the route's validator, which includes three channels that
 * are never delivered, and coercing them away here would hide from the screen
 * exactly the thing the screen has to show.
 */
export const ruleSchema = z.object({
  id: z.string().min(1),
  /** `null` is tenant-wide. The route's list filter spells it `"null"`. */
  departmentId: z.string().nullable().default(null),
  eventType: z.string().min(1),
  enabled: z.boolean().default(true),
  channels: z.array(z.string()).default([]),
  recipients: recipientsSchema,
  priority: z.enum(RULE_PRIORITIES).catch('MEDIUM'),
  conditions: z
    .union([z.string(), z.array(conditionSchema)])
    .nullable()
    .default(null),
});

export const rulesSchema = z.array(ruleSchema);

export type NotificationRule = z.infer<typeof ruleSchema>;

/** Channels on this rule that the dispatcher will silently drop. */
export function undeliverableChannels(rule: NotificationRule): readonly string[] {
  return rule.channels.filter(
    (channel) => !(DELIVERED_CHANNELS as readonly string[]).includes(channel),
  );
}

/** True when nothing this rule asks for can actually be delivered. */
export function deliversNothing(rule: NotificationRule): boolean {
  return rule.channels.length > 0 && undeliverableChannels(rule).length === rule.channels.length;
}

/**
 * Tenant-wide rules that a department-scoped rule for the same event displaces.
 *
 * `engine:138` does not merge the two — if any department row matches, the
 * tenant-wide rows are filtered out entirely, so their recipients are told
 * nothing about that department's events. Both rows still read as enabled,
 * which is why the screen has to say which is which.
 *
 * Disabled rules are excluded on both sides: the engine's own query filters
 * `enabled: true`, so a disabled department rule displaces nothing.
 */
export function shadowedRuleIds(rules: readonly NotificationRule[]): ReadonlySet<string> {
  const eventsWithDepartmentRule = new Set(
    rules.filter((r) => r.enabled && r.departmentId !== null).map((r) => r.eventType),
  );

  return new Set(
    rules
      .filter(
        (r) => r.enabled && r.departmentId === null && eventsWithDepartmentRule.has(r.eventType),
      )
      .map((r) => r.id),
  );
}
