import { z } from 'zod';

/**
 * AI employees — screen 07.
 *
 * Shapes read from `services/ai/src/routes/ai-agents.ts`.
 *
 * ── THREE VERBS OF FOUR ──
 * The design says *"Hire, edit, pause, fire"*. `AIAgentStatus` is
 * `ACTIVE | DRAFT | PAUSED` — **there is no `RETIRED`.** Firing is not a state
 * this platform has, and the screen says which verb is missing rather than
 * quietly listing three: a missing verb in a stated list of four reads as an
 * oversight, and this one is a fact about the product.
 *
 * ── PAUSING DOES NOTHING TO OPEN CONVERSATIONS ──
 * `ai-bot.service.ts:4797` is the whole behaviour:
 * ```js
 * if (config.status === "PAUSED") return { reply: null, … };
 * ```
 * No handover, no reassignment, no notification. **A customer mid-conversation
 * simply stops getting replies**, and nothing tells them or anyone else. The
 * screen says so at the moment of pausing, because the person clicking it is
 * not the person who bears the consequence — the same shape as the
 * unenforced quiet hours.
 *
 * ── THE THREE COUNTS, AND THE ONE THAT IS ABSENT ──
 * The route defines its scope once and spreads it into all three queries,
 * excluding sandbox rows (*"a permanent phantom, one per person who ever
 * clicked Test"*) and setup rehearsals. Imported history is excluded by the
 * platform's own default, deliberately not restated.
 *
 * **There is no escalation count**, and the route explains why: `isHandedOver`
 * has six-plus writers sharing only *"a person ended up driving"*, and the
 * cause would need `ConversationHandover.reason`, which **holds zero rows
 * while five conversations carry the flag** — so a cause column would be *"a
 * confident zero for every employee"*. Neither source is honest, so neither is
 * drawn.
 */

export const EMPLOYEE_STATUSES = ['ACTIVE', 'DRAFT', 'PAUSED'] as const;
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number];

export const employeeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** `customer_support`, `sales`, `booking`, `billing`, `custom`. */
  role: z.string().default(''),
  status: z.enum(EMPLOYEE_STATUSES).catch('DRAFT'),
  /** `["whatsapp", "instagram", …]` — where this employee answers. */
  channels: z.array(z.string()).default([]),
  departmentName: z.string().nullable().default(null),
  knowledgeSources: z
    .array(
      z.object({
        id: z.string(),
        name: z.string().default(''),
        isActive: z.boolean().default(false),
      }),
    )
    .default([]),
  /** Last time someone opened the test chat. Null if never. */
  lastTestedAt: z.string().nullable().default(null),

  /**
   * OPEN + WAITING. **Not "being handled right now"** — the route's own note
   * says WAITING is usually waiting on the CUSTOMER, so this must not be
   * captioned as live activity.
   */
  openConversations: z.number().default(0),
  /** Everything ever routed here, open or finished. The denominator. */
  handledConversations: z.number().default(0),
  /** Finished, and finished without a person taking over. */
  resolvedAlone: z.number().default(0),

  /*
   * ── 07's DETAIL: what the list route already sends (it spreads the row) ──
   * Each is `.catch`-ed: a field only the detail draws must never reject the
   * whole list. `systemPrompt` and the model settings are NOT named — no
   * card shows them, and a prompt has no business in a browser payload.
   */
  /** `professional`, `friendly`, `casual`, `formal`. */
  tone: z.string().catch('').default(''),
  /** `{ english: true, hebrew: false, arabic: false }`. */
  languages: z.record(z.string(), z.boolean()).catch({}).default({}),
  /** `[{ label, type, value, enabled }]` — the label is written by a person. */
  escalationRules: z
    .array(
      /*
       * `.passthrough()`: the stored rule also has `type` and `value`. PATCH
       * replaces the whole array, so 07f's Save must send them back as read.
       */
      z
        .object({
          label: z.string().catch('').default(''),
          enabled: z.boolean().catch(true).default(true),
        })
        .passthrough(),
    )
    .catch([])
    .default([]),
  /** `{ role, responsibility, … }` — the responsibility is 07's subline. */
  identity: z
    .object({ responsibility: z.string().nullable().catch(null).default(null) })
    // PATCH replaces the whole object: `role` and the guidelines ride along.
    .passthrough()
    .nullable()
    .catch(null)
    .default(null),
  goal: z.string().nullable().catch(null).default(null),
  /** 07e's "Hired …" time. Nothing records who created it. */
  createdAt: z.string().nullable().catch(null).default(null),
  /** 07f's "Last edited …". Nothing records who edited it. */
  updatedAt: z.string().nullable().catch(null).default(null),
  /**
   * The last readiness test, persisted by `POST …/readiness-test`. Only what
   * 07e draws: when it ran and what it recommends. The questions, the
   * coverage and the score stay on the server.
   */
  readinessReport: z
    .object({
      generatedAt: z.string().nullable().catch(null).default(null),
      recommendations: z
        .array(
          z.object({
            type: z.string().catch('other').default('other'),
            title: z.string().catch('').default(''),
            detail: z.string().catch('').default(''),
          }),
        )
        .catch([])
        .default([]),
    })
    .nullable()
    .catch(null)
    .default(null),
});

export type Employee = z.infer<typeof employeeSchema>;

/** The tones the builder writes. Anything else is humanised. */
export const EMPLOYEE_TONES = ['professional', 'friendly', 'casual', 'formal'] as const;

/** Languages it answers in, in the builder's order: `english`, `hebrew`, `arabic`. */
export function employeeLanguages(employee: Employee): readonly string[] {
  return Object.entries(employee.languages)
    .filter(([, on]) => on)
    .map(([language]) => language);
}

/** The handover rules that are switched on and say something. */
export function handoverRules(employee: Employee): readonly string[] {
  return employee.escalationRules
    .filter((rule) => rule.enabled && rule.label.trim() !== '')
    .map((rule) => rule.label.trim());
}

/** 07's line under the name: what it is responsible for, or its goal. */
export function responsibilityOf(employee: Employee): string | null {
  return employee.identity?.responsibility?.trim() || employee.goal?.trim() || null;
}

export const employeeListSchema = z.array(employeeSchema);

/**
 * The share this employee finished without a person stepping in.
 *
 * `null` rather than zero when nothing has been routed here yet — "has never
 * handled a conversation" and "handled some and needed help every time" are
 * opposite facts, and 0% would state the second about an employee in the
 * first position.
 */
/** The five roles the platform names. Anything else is humanised. */
const NAMED_ROLES = new Set(['customer_support', 'sales', 'booking', 'billing', 'custom']);

/**
 * The message key for an employee's role, or `null` when there is no role.
 *
 * Three states, and the third is the one the screen was missing entirely:
 * a named role, a role the platform has added since this list was written, and
 * **no role at all** — which is a real state, because `role` defaults to `''`.
 *
 * An employee nobody has said anything about is the interesting row on that
 * screen; it is usually a draft somebody abandoned. Rendering the row and
 * saying it is unset is the point. Omitting the row would read as "this product
 * has no such concept", which is a different sentence and not a true one.
 */
export function roleKeyOf(employee: Employee): string | null {
  const role = employee.role.trim();
  if (role === '') return null;
  return NAMED_ROLES.has(role) ? role : null;
}

/** Knowledge sources this employee is attached to but cannot actually read. */
export function inactiveSources(employee: Employee): number {
  return employee.knowledgeSources.filter((source) => !source.isActive).length;
}

export function aloneRate(employee: Employee): number | null {
  return employee.handledConversations > 0
    ? employee.resolvedAlone / employee.handledConversations
    : null;
}

/**
 * What `DELETE /api/ai-agents/:id` reports it actually did.
 *
 * A **result**, not a prediction. The dialog says what will happen; this says
 * what happened, and where they disagree this one is the evidence.
 */
export const deleteResultSchema = z.object({
  /** Routing-canvas nodes that pointed at this employee. */
  removedRoutingRules: z.number().default(0),
  removedToolGrants: z.number().default(0),
  /** LIVE conversations only. Closed ones keep their attribution. */
  releasedConversations: z.number().default(0),
});

export type DeleteResult = z.infer<typeof deleteResultSchema>;

/**
 * Conversations this employee finished, which **keep its id after deletion**.
 *
 * The route releases `status: { not: "CLOSED" }` only. On a finished thread
 * that id is the record of **which employee handled it**, and it is what the
 * "handled in total" and "finished alone" figures read. Releasing all of them
 * would have erased the history to tidy a foreign key.
 *
 * So a merchant is told the record survives: **deleting an employee does not
 * unmake the work it did**, and someone who believes otherwise will make a
 * different decision.
 */
export function finishedConversations(employee: Employee): number {
  return Math.max(0, employee.handledConversations - employee.openConversations);
}

/**
 * ── WHY THE DIALOG'S NUMBER AND THE SERVER'S CAN DIFFER ──
 * `openConversations` is counted with the list route's workload scope, which
 * **excludes sandbox rows and setup rehearsals**. The delete route releases
 * every non-closed conversation assigned to the employee, with no such
 * exclusions.
 *
 * So the server can legitimately release **more** than the dialog predicted —
 * the extra being test rows that were never anyone's customer. The dialog is
 * the honest forecast of real people affected; the result is what the
 * database did. Neither is wrong, and the screen shows the result afterwards
 * rather than insisting the forecast was right.
 */

/** Only a live employee can be paused; only a paused one can be resumed. */
export function canPause(employee: Employee): boolean {
  return employee.status === 'ACTIVE';
}

export function canResume(employee: Employee): boolean {
  return employee.status === 'PAUSED';
}

/**
 * Would pausing this employee leave somebody mid-conversation?
 *
 * The warning is always true, but it is **concrete** when there are open
 * conversations — and a number is what makes a consequence land. Zero open
 * conversations still warns, because one can arrive between reading and
 * clicking.
 */
export function openConversationsAtRisk(employee: Employee): number {
  return employee.openConversations;
}
