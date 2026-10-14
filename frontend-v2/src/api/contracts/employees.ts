import { z } from 'zod';

/**
 * AI employees - screen 07.
 *
 * Shapes read from `services/ai/src/routes/ai-agents.ts`.
 *
 * ── THREE VERBS OF FOUR ──
 * The design says *"Hire, edit, pause, fire"*. `AIAgentStatus` is
 * `ACTIVE | DRAFT | PAUSED` - **there is no `RETIRED`.** Firing is not a state
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
 * not the person who bears the consequence - the same shape as the
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
 * while five conversations carry the flag** - so a cause column would be *"a
 * confident zero for every employee"*. Neither source is honest, so neither is
 * drawn.
 */

export const EMPLOYEE_STATUSES = ['ACTIVE', 'DRAFT', 'PAUSED'] as const;
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number];

/** One question of a readiness test, and how well the employee can answer it. */
export const readinessQuestionSchema = z.object({
  question: z.string().min(1),
  coverage: z.enum(['full', 'partial', 'none']),
  reason: z.string().catch('').default(''),
});

export type ReadinessQuestion = z.infer<typeof readinessQuestionSchema>;

export const employeeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** `customer_support`, `sales`, `booking`, `billing`, `custom`. */
  role: z.string().default(''),
  status: z.enum(EMPLOYEE_STATUSES).catch('DRAFT'),
  /*
   * No `channels` (Backend, 2026-10-07): the field is read by nothing at
   * runtime - where an employee answers is the playbook's and automations'
   * (`route_target`, `hand_to_ai`). `object` strips it if the route sends it.
   */
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
   * OPEN + WAITING. **Not "being handled right now"** - the route's own note
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
   * whole list. `systemPrompt` and the model settings are NOT named - no
   * card shows them, and a prompt has no business in a browser payload.
   */
  /** `professional`, `friendly`, `casual`, `formal`. */
  tone: z.string().catch('').default(''),
  /** `{ english: true, hebrew: false, arabic: false }`. */
  languages: z.record(z.string(), z.boolean()).catch({}).default({}),
  /** `[{ label, type, value, enabled }]` - the label is written by a person. */
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
  /**
   * E4: its own rules, in the owner's words - always a list since Backend
   * c0cd7fbc. Absent or malformed is `null`, "not read", never `[]`: Save
   * sends the whole list, and an empty one would erase rules nobody saw.
   */
  customGuardrails: z.array(z.string()).nullable().catch(null).default(null),
  /** `{ role, responsibility, … }` - the responsibility is 07's subline. */
  identity: z
    .object({ responsibility: z.string().nullable().catch(null).default(null) })
    // PATCH replaces the whole object: `role` and the guidelines ride along.
    .passthrough()
    .nullable()
    .catch(null)
    .default(null),
  goal: z.string().nullable().catch(null).default(null),
  /**
   * `{ disclosesAi, … }` - "Says it is AI when asked" (Backend 28a9c3b6):
   * absent means it does. Only that key is named; the rest rides along.
   */
  persona: z
    .object({ disclosesAi: z.boolean().optional().catch(undefined) })
    .passthrough()
    .nullable()
    .catch(null)
    .default(null),
  /** Its department, for the knowledge a department's employees read. */
  departmentId: z.string().nullable().catch(null).default(null),
  /** 07e's "Hired …" time. Nothing records who created it. */
  createdAt: z.string().nullable().catch(null).default(null),
  /** 07f's "Last edited …". Nothing records who edited it. */
  updatedAt: z.string().nullable().catch(null).default(null),
  /**
   * The last readiness test (`agent-readiness.service.ts`), stored on the
   * employee by the run after a hire and by `POST builder/:id/readiness-test`.
   * 07e draws its first recommendation; the employee page (H7) draws all of
   * it - the score, the questions it is not ready for, and what to do.
   */
  readinessReport: z
    .object({
      generatedAt: z.string().nullable().catch(null).default(null),
      /** 0-100; `null` when absent or not a number. */
      score: z.number().min(0).max(100).nullable().catch(null).default(null),
      totals: z
        .object({ full: z.number(), partial: z.number(), none: z.number(), total: z.number() })
        .nullable()
        .catch(null)
        .default(null),
      /** Read per row: a malformed question drops alone, never the report. */
      questions: z
        .array(z.unknown())
        .catch([])
        .default([])
        .transform((rows) =>
          rows.flatMap((row) => {
            const read = readinessQuestionSchema.safeParse(row);
            return read.success ? [read.data] : [];
          }),
        ),
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

/**
 * H7 (Backend 94ccaead): the last readiness run, from the employee's own read
 * (`GET /api/ai-agents/:id`; the list route does not carry it). Only these
 * four are named. `readinessStatus` is `null` when no run was ever recorded,
 * and ABSENT (`undefined`) from a server that does not store it - the page
 * tells the two apart, so neither defaults to the other. A run left
 * "running" for 10 minutes the server already reads as failed `timed_out`.
 */
export const readinessRunStatusSchema = z.object({
  readinessStatus: z.enum(['running', 'done', 'failed']).nullable().optional().catch(undefined),
  readinessStartedAt: z.string().nullable().optional().catch(null),
  readinessFinishedAt: z.string().nullable().optional().catch(null),
  /** agent_not_found, llm_unavailable, bad_model_output, internal_error, persist_failed, timed_out. */
  readinessError: z.string().nullable().optional().catch(null),
});

export type ReadinessRunStatus = z.infer<typeof readinessRunStatusSchema>;

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

/**
 * Whether it says it is an AI when a customer asks - the prompt builder's
 * rule (`persona.disclosesAi !== false`): absent, or anything but `false`, is yes.
 */
export function disclosesAi(employee: Employee): boolean {
  return employee.persona?.disclosesAi !== false;
}

/** 07's line under the name: what it is responsible for, or its goal. */
export function responsibilityOf(employee: Employee): string | null {
  return employee.identity?.responsibility?.trim() || employee.goal?.trim() || null;
}

export const employeeListSchema = z.array(employeeSchema);

/**
 * The share this employee finished without a person stepping in.
 *
 * `null` rather than zero when nothing has been routed here yet - "has never
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
 * **no role at all** - which is a real state, because `role` defaults to `''`.
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
 * So the server can legitimately release **more** than the dialog predicted -
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
 * conversations - and a number is what makes a consequence land. Zero open
 * conversations still warns, because one can arrive between reading and
 * clicking.
 */
export function openConversationsAtRisk(employee: Employee): number {
  return employee.openConversations;
}

/* ── Which business systems an employee may use (Backend 00c6c229 + 582acae2) ── */

/**
 * One system the workspace has set up, in any state: an integration by its
 * catalog slug, or a custom API tool / DB query as `custom:<id>`. `status`
 * is the connection's (`CONNECTED`, `ERROR`...) or a custom tool's
 * (`ACTIVE` / `INACTIVE`) - read as text, said in words by the screen.
 */
export const accessChoiceSchema = z.object({
  key: z.string(),
  kind: z.enum(['integration', 'custom_api', 'custom_db']).catch('integration'),
  name: z.string(),
  status: z.string(),
});
export type AccessChoice = z.infer<typeof accessChoiceSchema>;

export const integrationAccessSchema = z.object({
  allowed: z.array(z.string()),
  choices: z.array(accessChoiceSchema),
});
export type IntegrationAccess = z.infer<typeof integrationAccessSchema>;

/**
 * A choice's state in the screen's terms:
 *
 *   working   connected (or an active custom tool)
 *   failing   connected and broken - ERROR, DISCONNECTED
 *   off       a custom tool switched off
 *   waiting   not finished connecting (PENDING, TESTING), or a state not known here
 */
export function accessState(choice: AccessChoice): 'working' | 'failing' | 'off' | 'waiting' {
  switch (choice.status) {
    case 'CONNECTED':
    case 'ACTIVE':
      return 'working';
    case 'ERROR':
    case 'DISCONNECTED':
      return 'failing';
    case 'INACTIVE':
      return 'off';
    default:
      return 'waiting';
  }
}

/* ── Where an employee answers (Backend f79f1e6c + 9fd222d3) ── */

/**
 * `GET /api/ai-agents/:id/reachability`: per active channel of the
 * workspace, whether the playbook reaches this employee - `always` (the
 * single path) or `sometimes` (behind a branch: hours, a condition). A
 * channel where it never answers is absent. An older service sends no
 * `channels`: then it is unknown, never "nowhere".
 */
export const reachabilitySchema = z.object({
  hasCanvas: z.boolean().catch(false),
  reachable: z.boolean().catch(false),
  channels: z
    .array(
      z.object({
        channel: z.string(),
        reach: z.enum(['always', 'sometimes']),
        /**
         * E1 (Backend bf1655c3): the channel's own accounts - a WhatsApp number's
         * display name, its phone as `detail`. Optional: an older service sends
         * none, and the line is then the channel alone.
         */
        accounts: z
          .array(
            z.object({
              channelAccountId: z.string(),
              displayName: z.string().nullish().catch(null),
              detail: z.string().nullish().catch(null),
            }),
          )
          .optional()
          .catch(undefined),
      }),
    )
    .optional(),
});
export type Reachability = z.infer<typeof reachabilitySchema>;

/* ── What one employee may do, per action (E5, Backend a9fc1aca) ── */

/** The platform's three levels: run it, ask first, never. */
export const TOOL_LEVELS = ['execute', 'ask', 'never'] as const;
export type ToolLevel = (typeof TOOL_LEVELS)[number];
const toolLevel = z.enum(TOOL_LEVELS);

/**
 * `GET /api/ai-agents/:id/tools` - `{ tools: [...] }`. Per action: the
 * workspace's level (Integrations), this employee's own (`null`: like the
 * workspace), the effective one, and the levels it may be set to - never
 * looser than the workspace's.
 *
 * `label` is the catalogue's name in the reader's language for an
 * integration's action; for GOTCHA's own actions the server has none and
 * sends the tool's name, so the screen uses its own words there.
 *
 * Per row: a row that does not parse is left out, never the list.
 */
const employeeToolSchema = z.object({
  toolName: z.string().min(1),
  label: z.string().nullish().catch(null),
  integration: z.string().nullish().catch(null),
  riskGroup: z.string().nullish().catch(null),
  workspaceLevel: toolLevel,
  ownLevel: toolLevel.nullish().catch(null),
  employeeLevel: toolLevel,
  allowedLevels: z.array(toolLevel).catch([]),
  /**
   * Is this integration action GIVEN to this employee (Backend 9339ca26)? An
   * integration's action reaches an employee only when given to it. `null`
   * for a built-in, which needs no grant - and for a server that does not say.
   */
  granted: z.boolean().nullable().catch(null).default(null),
  /** It can be given: the workspace has set it up. Absent reads as no. */
  grantable: z.boolean().catch(false).default(false),
  /**
   * E3 (Backend 0d922065): where it is drawn. The integration's own name
   * (`null` for GOTCHA's built-ins), and its business section inside it -
   * `domain` keys it, `domainIcon` picks its icon, `domainLabel` names it in
   * the reader's language. Free strings: a section the server adds later is
   * drawn under its own label, never a rejected list.
   */
  integrationName: z.string().nullable().catch(null).default(null),
  domain: z.string().min(1).nullable().catch(null).default(null),
  domainIcon: z.string().nullable().catch(null).default(null),
  domainLabel: z.string().nullable().catch(null).default(null),
});
export type EmployeeTool = z.infer<typeof employeeToolSchema>;

export const employeeToolsSchema = z
  .object({ tools: z.array(z.unknown()).catch([]) })
  .transform(({ tools }) =>
    tools.flatMap((row): EmployeeTool[] => {
      const item = employeeToolSchema.safeParse(row);
      return item.success ? [item.data] : [];
    }),
  );
