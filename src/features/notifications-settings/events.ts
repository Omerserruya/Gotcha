/**
 * The events a notification rule may be written against.
 *
 * ── WHY THIS LIST IS 22 AND NOT 28 ──
 * An event type is drawable only when it is **both templated and emitted**.
 * Templates alone answer *"is this a valid type?"*; what a settings screen must
 * ask is *"can this actually reach someone?"* — because a rule written against
 * a type nothing raises is a control that does nothing, and the admin would
 * believe they had configured something.
 *
 * Six types are templated and emitted by nothing, and are deliberately absent:
 *
 *     high_value_lead.detected · invoice.issued · lead.created
 *     payment_method.expiring · subscription.trial_ending
 *     system.error.critical
 *
 * The last is the one to notice: **the notification type for the single thing
 * an operator would most want to be woken up about cannot fire.** It is
 * declared, it has a template, and nothing emits it.
 *
 * ── WHY THIS LIST IS HERE AND NOT DERIVED ──
 * The platform declares its event vocabulary in **three** separate unions —
 * `services/ai/.../notifications-emit.ts`, `services/notifications/.../
 * event-emitter.service.ts` and `services/billing/src/lib/events.ts` — and the
 * source comment warning that they have drifted says there are two. Nothing
 * reconciles them, so no single file can be followed as the authority.
 *
 * This list is therefore a deliberate snapshot, and it will go stale. When a
 * backend endpoint serves the vocabulary, delete this and read that instead.
 */

/** Grouped so 22 rows read as a structure rather than a wall. */
export const EVENT_FAMILIES = ['work', 'systems', 'commerce', 'billing'] as const;
export type EventFamily = (typeof EVENT_FAMILIES)[number];

export interface NotifiableEvent {
  readonly type: string;
  readonly family: EventFamily;
  /**
   * `true` where the platform's own source comment explains what the event
   * does and does NOT mean. Those comments are the copy — see the i18n
   * catalogue — because the person who wrote the emitter had already thought
   * about exactly the misreading the design's wording invites.
   */
  readonly hasSourceCaveat?: boolean;
}

export const NOTIFIABLE_EVENTS: readonly NotifiableEvent[] = [
  // ── Work ──────────────────────────────────────────────────────────
  { type: 'tool.approval_required', family: 'work' },
  { type: 'conversation.escalated', family: 'work' },
  /*
   * Emitted only on REASSIGNMENT, never on a self-claim. The emitter's own
   * comment: "telling someone they picked up the conversation they just
   * clicked is the noise this screen exists to prevent" — which names this
   * screen's purpose better than the design does.
   */
  { type: 'conversation.assigned', family: 'work', hasSourceCaveat: true },

  // ── Systems ───────────────────────────────────────────────────────
  /*
   * NOT "a connected system stops responding", which is what the design draws.
   * The emitter's comment: "we checked and the credentials were rejected" —
   * not that the provider is down, and not continuous monitoring. It fires
   * only when somebody runs a test. The design's wording would promise a watch
   * that does not exist.
   */
  { type: 'integration.check_failed', family: 'systems', hasSourceCaveat: true },

  // ── Commerce ──────────────────────────────────────────────────────
  /*
   * "Not 'campaign succeeded' — failures count toward completion, so the body
   * states both numbers."
   */
  { type: 'broadcast.completed', family: 'commerce', hasSourceCaveat: true },
  { type: 'meeting.scheduled', family: 'commerce' },
  { type: 'discount.applied', family: 'commerce' },
  { type: 'refund.issued', family: 'commerce' },

  // ── Billing ───────────────────────────────────────────────────────
  { type: 'payment.failed', family: 'billing' },
  { type: 'invoice.paid', family: 'billing' },
  { type: 'credit.threshold', family: 'billing' },
  { type: 'credit.exhausted', family: 'billing' },
  { type: 'credit.auto_purchase_succeeded', family: 'billing' },
  { type: 'credit.auto_purchase_failed', family: 'billing' },
  { type: 'credit.auto_purchase_ceiling_reached', family: 'billing' },
  { type: 'subscription.activated', family: 'billing' },
  { type: 'subscription.trial_started', family: 'billing' },
  { type: 'subscription.plan_changed', family: 'billing' },
  { type: 'subscription.past_due', family: 'billing' },
  { type: 'subscription.suspended', family: 'billing' },
  { type: 'subscription.resumed', family: 'billing' },
  { type: 'subscription.canceled', family: 'billing' },
];

/**
 * Types that are templated but that nothing emits.
 *
 * Kept as data rather than a comment so the test can assert they are never
 * offered. A rule written against one of these can never fire, and an admin
 * who wrote it would believe they had configured something.
 *
 * ── THIS LIST IS THE ONLY VALIDATION THERE IS ──
 * `POST /api/notification-preferences` validates `eventType` against **no set
 * at all** — a non-empty string is the whole check, and `PATCH` does not even
 * trim. Every other field in that payload has a closed set behind it.
 *
 * So `conversaton.escalated` is accepted, answers `201`, appears in the list,
 * reads as enabled, and matches nothing for as long as it exists. Nothing at
 * write time or read time says otherwise. **The frontend is the only place in
 * the system where this can be caught**, which makes the vocabulary above a
 * safety property rather than a convenience — and means the screen also has
 * to flag the rows it did not create. See `eventStatus` in `rule-view.ts`,
 * which separates "nothing raises this" from "no such event": different
 * causes, different remedies, and an admin sent to the wrong one either way.
 */
export const UNFIRING_EVENTS: readonly string[] = [
  'high_value_lead.detected',
  'invoice.issued',
  'lead.created',
  'payment_method.expiring',
  'subscription.trial_ending',
  'system.error.critical',
];

export function eventsInFamily(family: EventFamily): readonly NotifiableEvent[] {
  return NOTIFIABLE_EVENTS.filter((event) => event.family === family);
}
