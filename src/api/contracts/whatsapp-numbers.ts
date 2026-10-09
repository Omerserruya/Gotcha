import { z } from 'zod';

/**
 * WhatsApp numbers - screen 13.
 *
 * `GET /api/channels/whatsapp/numbers`, and the per-number verbs beneath it.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE RESPONSE HAS TWO ARRAYS AND THEY ARE NOT THE SAME KIND OF THING
 * ════════════════════════════════════════════════════════════════════════════
 * `data` is numbers with a lifecycle row: state, health checks, repairs, an
 * audit trail. `unprofiled` is a WhatsApp channel connected before any of that
 * existed - real, working, and with **no health information at all**.
 *
 * The route surfaces them "rather than hiding them, because a number the
 * customer can see in their inbox but not on this page reads as a bug".
 *
 * **On this tenant `data` is empty and `unprofiled` has exactly one entry.**
 * So the only state screen 13 can actually show is a connected number about
 * which nothing is known - which must read as working, and must not offer a
 * single repair control, because none of them can run against it.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * RECEIVING AND SENDING FAIL SEPARATELY
 * ════════════════════════════════════════════════════════════════════════════
 * The report carries both as their own booleans, and the platform's comment
 * records what collapsing them cost:
 *
 * > *"A number that receives customer messages IS connected and IS doing work,
 * > even while Meta blocks outbound over a billing problem on the WABA.
 * > Folding both into one verdict reported that number as '0 working, 1 needs
 * > attention' to a customer whose inbox was filling up."*
 *
 * `ready` is in the same object - a single derived verdict, and exactly the
 * field a card binds to by default. {@link deliveryState} exists so nothing
 * here ever binds to it alone.
 * ════════════════════════════════════════════════════════════════════════════
 */

export const NUMBER_STATES = [
  'DISCOVERED',
  'ONBOARDING',
  'ACTION_REQUIRED',
  'CONNECTED',
  'DEGRADED',
  'DISCONNECTED',
  'FAILED',
] as const;
export type NumberState = (typeof NUMBER_STATES)[number];

export const CHECK_IDS = [
  'CONNECTED',
  'MESSAGING',
  'WEBHOOKS',
  'VERIFICATION',
  'QUALITY',
  'REGISTRATION',
] as const;

/** Repairs GOTCHA can genuinely perform itself. */
export const REPAIR_ACTIONS = [
  'RESUBSCRIBE_WEBHOOKS',
  'REFRESH_STATUS',
  'REQUEST_HISTORY_SYNC',
] as const;
export type RepairAction = (typeof REPAIR_ACTIONS)[number];

export const healthCheckSchema = z.object({
  id: z.enum(CHECK_IDS),
  label: z.string(),
  status: z.enum(['PASS', 'WARN', 'FAIL', 'UNKNOWN']),
  detail: z.string().nullable().optional(),
  /**
   * Meta's own remediation text, **verbatim**. Never rewritten and never
   * translated - same rule as the billing estimate disclaimer: one string,
   * one owner. A paraphrase of a platform's fix instructions is a new
   * instruction that nobody tested.
   */
  metaSolution: z.string().nullable().optional(),
  metaErrorCode: z.number().nullable().optional(),
  /**
   * Does this stop messages flowing TODAY?
   *
   * Without it *"an unregistered number sat in the same flat list as a SIP
   * calling notice, and the customer could not tell which one was the reason
   * nothing worked."*
   */
  blocking: z.boolean().default(false),
});

export type HealthCheck = z.infer<typeof healthCheckSchema>;

export const healthReportSchema = z.object({
  state: z.enum(NUMBER_STATES),
  /** A single derived verdict. Never bound to on its own - see deliveryState. */
  ready: z.boolean().default(false),
  receiving: z.boolean().default(false),
  sending: z.boolean().default(false),
  checks: z.array(healthCheckSchema).default([]),
  availableRepairs: z.array(z.enum(REPAIR_ACTIONS)).default([]),
  /**
   * The ONE blocked state the customer can clear from inside GOTCHA.
   *
   * Error 141000: Meta has the number but it was never registered for Cloud
   * API, so it receives and cannot send. `resume` runs the register step with
   * their two-step PIN. Everything else in a blocked report is resolved in
   * Meta's own settings - which is why this is its own flag and not one more
   * entry in `customerActions`.
   */
  needsRegistration: z.boolean().default(false),
  /**
   * Problems only the customer can resolve, and only in Meta.
   *
   * Separated from `availableRepairs` *"so the UI never offers a button that
   * cannot work; offering one and having it fail is worse than saying plainly
   * that this one is theirs to fix."*
   */
  customerActions: z.array(healthCheckSchema).default([]),
  lastCheckedAt: z.string().nullable().default(null),
  /**
   * Meta's raw health response.
   *
   * Carried because the CHECKS flatten the thing screen 13's banner turns on.
   * `healthEntitiesToChecks` maps every non-registration block to
   * `id: "MESSAGING"` and puts the entity in `label` as display text
   * ("Message templates"), so telling a template block from a phone-number
   * block would mean matching an English string. `entity_type` is in here.
   */
  healthSnapshot: z
    .object({
      entities: z
        .array(
          z.object({
            entity_type: z.string().nullable().default(null),
            can_send_message: z.string().nullable().default(null),
            errors: z
              .array(
                z.object({
                  error_code: z.number().nullable().default(null),
                  error_description: z.string().nullable().default(null),
                  possible_solution: z.string().nullable().default(null),
                }),
              )
              .default([]),
          }),
        )
        .default([]),
    })
    .nullable()
    .default(null),
});

export type HealthReport = z.infer<typeof healthReportSchema>;

/**
 * The number as Meta displays it, or null - an empty string is not a number.
 * When it is null the card says it has not been read from Meta yet; the raw
 * id is never shown in its place.
 */
const displayPhone = z
  .string()
  .nullable()
  .catch(null)
  .default(null)
  .transform((v) => v?.trim() || null);

export const numberSchema = z.object({
  id: z.string(),
  phoneNumber: displayPhone,
  name: z.string().nullable().default(null),
  state: z.enum(NUMBER_STATES),
  pendingAction: z.string().nullable().default(null),
  /** The channel account behind the number - where its AI mode lives (13b). */
  channelAccountId: z.string().nullable().catch(null).default(null),
  /** Coexistence numbers behave differently, so the card must know. */
  usesBusinessApp: z.boolean().default(false),
  qualityRating: z.string().nullable().default(null),
  throughputLevel: z.string().nullable().default(null),
  health: healthReportSchema,
});

export type WhatsAppNumber = z.infer<typeof numberSchema>;

/**
 * A WhatsApp channel with no lifecycle row.
 *
 * Connected, working, and carrying **no health at all** - not "healthy", and
 * not "broken". The card for one of these states what is true (it is
 * connected) and what is unknown (everything else), and offers no repair,
 * because every repair verb addresses a `WhatsAppNumber` that does not exist.
 */
export const unprofiledSchema = z.object({
  channelAccountId: z.string(),
  phoneNumberId: z.string(),
  /** Backend adds it (2026-10-09); dev's account has none stored. */
  phoneNumber: displayPhone,
  name: z.string().nullable().default(null),
  connectionStatus: z.string(),
  /**
   * The route's own sentence, in English only - there is no `noteHe`.
   *
   * Unlike the billing disclaimer, which ships translated and is a commercial
   * claim, this is an operational explanation with no Hebrew available. So it
   * is translated in our catalogue rather than rendered verbatim: putting
   * English on the one card a Hebrew tenant can see is the worse of the two
   * errors, and nothing about a plan's price depends on the wording.
   */
  note: z.string().nullable().default(null),
});

export type UnprofiledNumber = z.infer<typeof unprofiledSchema>;

export const numbersResponseSchema = z.object({
  data: z.array(numberSchema).default([]),
  unprofiled: z.array(unprofiledSchema).default([]),
});

export type NumbersResponse = z.infer<typeof numbersResponseSchema>;

/* ── What a card is allowed to say ───────────────────────────────────────── */

/**
 * The four honest answers to "is this number working", which `ready` alone
 * cannot give.
 *
 * `outbound_blocked` is the one that matters: a number taking customer
 * messages while Meta refuses its replies is **not** "needs attention" and is
 * **not** "working". It is doing half its job, and the half it is doing is the
 * one the customer's inbox depends on.
 */
export type DeliveryState = 'working' | 'inbound_only' | 'outbound_only' | 'down';

export function deliveryState(health: HealthReport): DeliveryState {
  if (health.receiving && health.sending) return 'working';
  if (health.receiving) return 'inbound_only';
  if (health.sending) return 'outbound_only';
  return 'down';
}

/** Checks that stop messages today, which lead the card. */
export function blockingChecks(health: HealthReport): readonly HealthCheck[] {
  return health.checks.filter((c) => c.blocking && c.status !== 'PASS');
}

/** Everything else that is not passing - real, and filed under "worth knowing". */
export function advisoryChecks(health: HealthReport): readonly HealthCheck[] {
  return health.checks.filter((c) => !c.blocking && c.status !== 'PASS');
}

/**
 * Can the customer clear this from inside GOTCHA?
 *
 * True only for the registration case. Everything else in `customerActions`
 * is resolved in Meta, and a control here would be a button that cannot work.
 */
export function fixableHere(health: HealthReport): boolean {
  return health.needsRegistration;
}

/**
 * Is there anything at all this screen can DO for this number?
 *
 * False for an unprofiled channel and for a number whose only problems live
 * in Meta's settings. Used to decide whether an actions area renders at all,
 * rather than rendering an empty one that looks like a loading failure.
 */
export function hasAnyAction(health: HealthReport): boolean {
  return health.availableRepairs.length > 0 || health.needsRegistration;
}

/* ── Templates, which pause without the channel going down ───────────────── */

/**
 * Why outbound TEMPLATES are blocked, when they are.
 *
 * Meta reports `can_send_message` per entity, and `MESSAGE_TEMPLATE` is its
 * own entity. So a business can be taking customer messages and answering
 * them inside the 24-hour window while Meta refuses every reminder, cart
 * recovery and campaign - which is the state Omer asked to be warned about,
 * and it is `receiving`/`sending` one level finer.
 *
 * **The reason is Meta's, verbatim.** The design's copy says *"your WhatsApp
 * Business account has no payment method"*, and that is one cause among
 * several - quality rating and policy violations block templates too. We
 * report the block, which we know, and quote Meta for the cause, which they
 * know and we do not. Same rule as `metaSolution` on a health check.
 */
export interface TemplateBlock {
  /** Meta's own description of what is wrong. Never paraphrased. */
  reason: string | null;
  /** Meta's own remediation text. Never paraphrased. */
  solution: string | null;
  errorCode: number | null;
}

export function templatesPaused(health: HealthReport): TemplateBlock | null {
  const entity = health.healthSnapshot?.entities.find(
    (e) => e.entity_type === 'MESSAGE_TEMPLATE' && e.can_send_message === 'BLOCKED',
  );
  if (!entity) return null;

  const err = entity.errors[0];
  return {
    reason: err?.error_description ?? null,
    solution: err?.possible_solution ?? null,
    errorCode: err?.error_code ?? null,
  };
}

/**
 * Does the number still carry ordinary replies while templates are paused?
 *
 * The design's second sentence - *"Replies within 24 hours still go out"* - is
 * the part that stops the banner reading as "WhatsApp is down". It is only
 * true while the number is actually receiving, so it is gated on that rather
 * than stated as a general fact about WhatsApp.
 */
export function repliesStillFlow(health: HealthReport): boolean {
  return health.receiving;
}

/**
 * How many numbers the account has - BOTH lists. A number set up before
 * per-number health is UNPROFILED, and is still a number: counting only the
 * profiled ones put "no numbers yet" over a connected number's card (13b).
 * The head and the card must read the same object through this.
 */
export function numberCount(numbers: NumbersResponse): number {
  return numbers.data.length + numbers.unprofiled.length;
}

/**
 * 13b's "Private contacts" (`GET /api/channels/whatsapp/exclusions`): the
 * numbers whose inbound messages GOTCHA does not take - a person's own
 * contacts on a shared number. `value` is what was typed, `normalized` what
 * it matches on; both, so a rule is never shown rewritten.
 */
export const exclusionSchema = z.looseObject({
  id: z.string(),
  value: z.string(),
  normalized: z.string().catch(''),
  channelAccountId: z.string().nullable().catch(null).default(null),
  note: z.string().nullable().catch(null).default(null),
  createdAt: z.string().nullable().catch(null).default(null),
});
export type Exclusion = z.infer<typeof exclusionSchema>;
export const exclusionListSchema = z.object({ data: z.array(exclusionSchema).catch([]) });

/** The steps the pipeline records (`WhatsAppNumberEvent.outcome`). */
export const EVENT_OUTCOMES = ['SUCCESS', 'FAILED', 'SKIPPED', 'ACTION_REQUIRED'] as const;

/**
 * 13b's "Activity" (`GET …/numbers/:id/events`): what happened to a number,
 * newest first, up to 100 - connect, register, health checks, repairs. The
 * step is the pipeline's own name; Meta's message is shown as it came.
 */
export const numberEventSchema = z.looseObject({
  id: z.string(),
  step: z.string(),
  outcome: z.enum(EVENT_OUTCOMES).or(z.string()),
  metaErrorCode: z.number().nullable().catch(null).default(null),
  message: z.string().nullable().catch(null).default(null),
  createdAt: z.string(),
});
export type NumberEvent = z.infer<typeof numberEventSchema>;
export const numberEventListSchema = z.object({ data: z.array(numberEventSchema).catch([]) });
