import type { Employee, ReadinessQuestion, ReadinessRunStatus } from '@/api/contracts/employees';

/** Where each kind of readiness recommendation is resolved. */
export const RESOLVE_AT: Readonly<
  Record<string, '/studio/knowledge' | '/settings/systems' | undefined>
> = {
  add_knowledge: '/studio/knowledge',
  add_faq: '/studio/knowledge',
  add_business_data: '/studio/knowledge',
  connect_tool: '/settings/systems',
};

/** The failure codes the platform writes (`readiness-status.ts`, the report's own errors). */
export const READINESS_FAILURES = [
  'agent_not_found',
  'llm_unavailable',
  'bad_model_output',
  'internal_error',
  'persist_failed',
  'timed_out',
  // The model's answer was cut off twice; nothing stored, and running again retries it.
  'judge_incomplete',
] as const;
export type ReadinessFailure = (typeof READINESS_FAILURES)[number] | 'other';

/**
 * A server from before the stored status (Backend 94ccaead) says nothing of
 * a run: after a hire it is believed running for this long. One LLM call,
 * about a minute.
 */
export const AFTER_HIRE_WINDOW_MS = 3 * 60_000;

/** The route's bound on an answer written into the knowledge (E2, Backend 201ad16a). */
export const MAX_READINESS_ANSWER = 20_000;

/**
 * The questions it is not ready for: none first, then partial, each group in
 * the report's order. A fully covered question is not a gap, and neither is
 * one a person answered (E2) - that answer covers it.
 */
export function readinessGaps(questions: readonly ReadinessQuestion[]): ReadinessQuestion[] {
  const open = questions.filter((q) => !q.answered);
  return [
    ...open.filter((q) => q.coverage === 'none'),
    ...open.filter((q) => q.coverage === 'partial'),
  ];
}

/** E2: the questions a person answered, in the report's order. */
export function readinessAnswered(questions: readonly ReadinessQuestion[]): ReadinessQuestion[] {
  return questions.filter((q) => q.answered);
}

/** What the card says of the last run: running, failed with why, or nothing. */
export type ReadinessRun =
  | { readonly state: 'running' }
  | { readonly state: 'failed'; readonly failure: ReadinessFailure }
  | { readonly state: 'idle' };

/**
 * The run, from the stored status (H7, Backend 94ccaead) - read, never
 * guessed. The server turns a run left "running" for 10 minutes into
 * `failed: timed_out`, so "running" never spins forever.
 *
 * `status` is `null` when the status could not be read, and its
 * `readinessStatus` is `undefined` from a server that does not store it: only
 * then the old belief - no report, working, and changed (the hire is a
 * change) within the window.
 */
export function readinessRun(
  employee: Employee,
  status: ReadinessRunStatus | null,
  now: number,
): ReadinessRun {
  const stored = status?.readinessStatus;
  if (stored === 'running') return { state: 'running' };
  if (stored === 'failed') {
    const code = status?.readinessError ?? '';
    const failure = (READINESS_FAILURES as readonly string[]).includes(code)
      ? (code as ReadinessFailure)
      : 'other';
    return { state: 'failed', failure };
  }
  if (stored !== undefined) return { state: 'idle' };
  return runningAfterHire(employee, now) ? { state: 'running' } : { state: 'idle' };
}

function runningAfterHire(employee: Employee, now: number): boolean {
  if (employee.readinessReport !== null || employee.status !== 'ACTIVE') return false;
  if (!employee.updatedAt) return false;
  const since = now - new Date(employee.updatedAt).getTime();
  // A server clock a little ahead still counts; an unreadable time does not.
  return since < AFTER_HIRE_WINDOW_MS;
}
