import { z } from 'zod';

/**
 * Screen 04e — what happened in this customer's context.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠ THE READ THIS SCREEN NEEDS DOES NOT EXIST YET
 * ════════════════════════════════════════════════════════════════════════════
 * `GET /api/audit-logs` exists and is well built — cursor-paginated, tie-broken
 * on `id` because a burst of AI calls shares a millisecond, and honest about
 * what it does not know. But `buildWhere` accepts **`actorType`, `action`,
 * `from` and `to` and nothing else.** There is no `targetType` or `targetId`
 * filter, so it cannot be scoped to one customer at all.
 *
 * It is tenant-wide. A customer page cannot use it.
 *
 * ── AND THE JOIN MUST NOT BE COMPOSED HERE ──
 * Audit rows reach a customer three ways: `target_type='conversation'` (the
 * rich one), `'customer'` and `'order'`. The conversation link is a SOFT
 * join —
 *
 *     conversations.customer_external_id ↔ contacts.external_id
 *
 * — because `conversations` carries no `contact_id`. Composing that in the
 * BFF would give a merged contact an incomplete log, and **an incomplete log
 * looks like a quiet customer, not a broken join.** The platform already owns
 * `resolvePersonScope` and the sibling walk; this belongs behind them.
 *
 * So this file describes the row shape — taken from the existing route's own
 * response mapping, so a scoped endpoint can return exactly it — and the
 * screen waits for that endpoint rather than being built on a guess.
 */

/**
 * Who acted.
 *
 * ★ THERE IS NO `flow`. The design asks for AI, user and flow; the column is
 * `user | ai | system` only, so a flow-driven action arrives as one of those
 * three and the distinction the design draws cannot be made. Named on screen
 * rather than silently approximated.
 */
export const ACTOR_TYPES = ['user', 'ai', 'system'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

/** Which of the three ways a row reaches a customer. */
export const AUDIT_TARGETS = ['conversation', 'customer', 'order'] as const;
export type AuditTarget = (typeof AUDIT_TARGETS)[number];

export const auditEventSchema = z.object({
  id: z.string(),
  actorType: z.enum(ACTOR_TYPES).nullable().default(null),
  actorId: z.string().nullable().default(null),
  /**
   * The platform's own vocabulary — `ai.responded`,
   * `adapter.ok.shopify.get_order`, `adapter.err.shopify.process_refund`,
   * `crm.link.linked`. Rendered through a lookup where we have one and
   * verbatim where we do not, never invented.
   */
  action: z.string(),
  targetType: z.string().nullable().default(null),
  /**
   * ⚠ THE CONVERSATION THE ACTION HAPPENED IN, NOT THE THING ACTED ON. The
   * route says so itself: the order id lives in `metadata.args` and "has no
   * general shape across tools", so it is deliberately not promoted. A screen
   * that renders this as "the order" would name the wrong object.
   */
  targetId: z.string().nullable().default(null),
  createdAt: z.string(),
  /**
   * ★★ THREE-STATE, AND THE PLATFORM SAYS WHY IN ITS OWN COMMENT:
   * *"null when the emitter recorded no verdict, which is different from
   * false: 'we did not record whether this worked' is not 'it failed'."*
   *
   * Exactly the distinction this project has been drawing all week, arriving
   * from the other direction. A screen that renders null as a failure invents
   * a failed refund; one that renders it as success invents a completed one.
   */
  succeeded: z.boolean().nullable().default(null),
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

export const auditPageSchema = z.object({
  data: z.array(auditEventSchema).default([]),
  nextCursor: z.string().nullable().default(null),
});
export type AuditPage = z.infer<typeof auditPageSchema>;

/**
 * Did this action work?
 *
 * ★ TWO SIGNALS THAT CAN DISAGREE, AND THE NAME IS NOT THE VERDICT.
 *
 * `adapter.err.shopify.process_refund` carries the outcome in its NAME, while
 * `succeeded` carries it in `metadata.ok`. Both exist on the same rows and
 * nothing guarantees they agree — a row named `adapter.err.*` with
 * `succeeded: true` is possible and would be a platform bug, not a display
 * question.
 *
 * `succeeded` wins where it is present, because it is the emitter's explicit
 * verdict rather than a convention in a string. The prefix is the fallback,
 * and only then, so an unrecorded verdict is still `unknown` rather than
 * being resolved by a naming habit.
 */
export function outcomeOf(event: AuditEvent): 'worked' | 'failed' | 'unknown' {
  if (event.succeeded === true) return 'worked';
  if (event.succeeded === false) return 'failed';
  if (event.action.startsWith('adapter.err.')) return 'failed';
  if (event.action.startsWith('adapter.ok.')) return 'worked';
  return 'unknown';
}

/**
 * Do the two signals contradict each other?
 *
 * Worth surfacing rather than silently preferring one: it means the emitter
 * and its own name disagree about whether a customer's refund happened, which
 * is a defect somebody should see rather than a rendering preference.
 */
export function outcomeIsContradictory(event: AuditEvent): boolean {
  if (event.succeeded === null) return false;
  if (event.action.startsWith('adapter.err.')) return event.succeeded === true;
  if (event.action.startsWith('adapter.ok.')) return event.succeeded === false;
  return false;
}

/** The tool an adapter row acted through, or null for anything else. */
export function toolOf(event: AuditEvent): string | null {
  const m = /^adapter\.(?:ok|err)\.(.+)$/.exec(event.action);
  return m?.[1] ?? null;
}
