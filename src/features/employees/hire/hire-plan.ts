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
  /** The action in words ("Get customer") - the tool catalogue's `actionLabel`. */
  readonly label: string;
  /** Its integration's slug and name; `null`: one of GOTCHA's own actions. */
  readonly provider: string | null;
  readonly providerLabel: string | null;
  readonly choices: readonly AdminChoice[];
  readonly current: AdminChoice;
}

/**
 * Step 2's groups (Omer, 2026-10-07): one per integration, by name, THEN
 * GOTCHA's own. The integrations come first because they are what the
 * question is about, and GOTCHA's own list is long (16 rows on dev): first,
 * it put them below the fold (supervisor, 2026-10-07).
 */
export function toolGroups(tools: readonly HireTool[]): readonly {
  readonly provider: string | null;
  readonly label: string | null;
  readonly tools: readonly HireTool[];
}[] {
  const byProvider = new Map<string | null, HireTool[]>();
  for (const tool of tools) {
    const list = byProvider.get(tool.provider) ?? [];
    list.push(tool);
    byProvider.set(tool.provider, list);
  }
  const own = byProvider.get(null);
  const integrations = [...byProvider.entries()]
    .filter(([provider]) => provider !== null)
    .map(([provider, list]) => ({ provider, label: list[0]!.providerLabel, tools: list }))
    .sort((a, b) => (a.label ?? a.provider ?? '').localeCompare(b.label ?? b.provider ?? ''));
  return [...integrations, ...(own ? [{ provider: null, label: null, tools: own }] : [])];
}

/** Step 1 is complete when there is a job - and, for "Something else", words. */
export function stepOneDone(plan: HirePlan): boolean {
  if (plan.job === null) return false;
  return plan.job !== 'custom' || plan.goal.trim().length > 0;
}

/*
 * ★ No "Where should it work?" (Omer, 2026-10-07): where an employee works is
 *   the playbook's and the automations' to decide, not a field on it - so the
 *   plan holds no channels and the builder is never sent any.
 */
export function emptyPlan(tools: readonly HireTool[]): HirePlan {
  return {
    job: null,
    goal: '',
    name: '',
    choices: Object.fromEntries(tools.map((tool) => [tool.toolName, tool.current])),
    handover: ['askPerson'],
  };
}
