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
});

export type Employee = z.infer<typeof employeeSchema>;

export const employeeListSchema = z.array(employeeSchema);

/**
 * The share this employee finished without a person stepping in.
 *
 * `null` rather than zero when nothing has been routed here yet — "has never
 * handled a conversation" and "handled some and needed help every time" are
 * opposite facts, and 0% would state the second about an employee in the
 * first position.
 */
export function aloneRate(employee: Employee): number | null {
  return employee.handledConversations > 0
    ? employee.resolvedAlone / employee.handledConversations
    : null;
}

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
