import type { AdminChoice } from '@/api/contracts/capabilities';

/**
 * 07b-07d's choices, held locally while the flow is read-only.
 *
 * ★ THE SHAPE THE BUILDER WILL TAKE, SO GOING LIVE IS PLUMBING.
 * Each field maps to one call on `/api/ai-agents/builder` - none is made yet
 * (Omer's call; a DRAFT row per walk-through, an LLM readiness test, and an
 * employee answering live customers):
 *
 *   job + goal     → POST /start { goal }            (creates the DRAFT)
 *   name           → POST /:id/refinements { name }
 *   channels       → PATCH /api/ai-agents/:id { channels }
 *   choices        → the tool permissions, per tool, as 10 writes them
 *   handover       → POST /:id/refinements { customGuardrails }
 *   step 3         → POST /:id/readiness-test         (LLM, costs tokens)
 *   Hire it        → POST /:id/complete               (DRAFT → ACTIVE)
 */
export interface HirePlan {
  readonly job: HireJob | null;
  /** The job in their own words, when the job is "Something else". */
  readonly goal: string;
  readonly name: string;
  readonly channels: readonly string[];
  readonly choices: Readonly<Record<string, AdminChoice>>;
  readonly handover: readonly string[];
}

/** The builder's roles (`agent-builder.service.ts`), plus the free-text job. */
export const HIRE_JOBS = ['customer_support', 'sales', 'booking', 'custom'] as const;
export type HireJob = (typeof HIRE_JOBS)[number];

/** 02's suggested "Always hand over to a person when…" chips. */
export const HANDOVER_SUGGESTIONS = ['askPerson', 'annoyed', 'vip', 'askedTwice'] as const;

/** One of the business's actions, as step 2 draws it. */
export interface HireTool {
  readonly toolName: string;
  readonly label: string;
  readonly group: 'answering' | 'commitments';
  readonly choices: readonly AdminChoice[];
  readonly current: AdminChoice;
}

/** Step 1 is complete when there is a job - and, for "Something else", words. */
export function stepOneDone(plan: HirePlan): boolean {
  if (plan.job === null) return false;
  return plan.job !== 'custom' || plan.goal.trim().length > 0;
}

export function emptyPlan(channels: readonly string[], tools: readonly HireTool[]): HirePlan {
  return {
    job: null,
    goal: '',
    name: '',
    channels: [...channels],
    choices: Object.fromEntries(tools.map((tool) => [tool.toolName, tool.current])),
    handover: ['askPerson'],
  };
}
