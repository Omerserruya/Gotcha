import type { SetupStatus, SetupStep } from '@/api/contracts/setup';

/**
 * The derivations behind the day-one block.
 *
 * Pure, so the arithmetic the header states out loud — how many are done, how
 * long the rest takes — can be tested without a translation runtime.
 */

/**
 * Where each step's action goes.
 *
 * "Every step completes inside the sheet it opens — none of them drop the user
 * into Settings and abandon them there." Until those sheets exist, a step
 * points at the page that owns it rather than at a route that does not exist.
 */
const DESTINATIONS: Record<string, string> = {
  connect_channel: '/settings',
  connect_store: '/settings',
  add_knowledge: '/studio/knowledge',
  hire_employee: '/studio/knowledge',
  handover_rules: '/settings',
  approval_limits: '/settings',
  test_conversation: '/inbox',
  invite_team: '/settings',
};

/** Steps with their own wording. An unrecognised id is shown, never hidden. */
const KNOWN_STEPS = new Set(Object.keys(DESTINATIONS));

export function stepDestination(id: string): string {
  return DESTINATIONS[id] ?? '/settings';
}

export function stepCopyKey(id: string): string | null {
  return KNOWN_STEPS.has(id) ? id : null;
}

export interface SetupProgress {
  readonly done: number;
  readonly total: number;
  /** Sum of the estimates for everything not yet done. */
  readonly minutesLeft: number;
  readonly isComplete: boolean;
}

export function setupProgress(status: SetupStatus): SetupProgress {
  const done = status.steps.filter((step) => step.state === 'done').length;
  const minutesLeft = status.steps
    .filter((step) => step.state !== 'done')
    .reduce((total, step) => total + step.estimateMinutes, 0);

  return {
    done,
    total: status.steps.length,
    minutesLeft,
    isComplete: status.steps.length > 0 && done === status.steps.length,
  };
}

/**
 * The one step to act on.
 *
 * The server decides it and promises exactly one. If a response ever carries
 * two, the first wins rather than the block raising both — two "do this next"
 * steps is not a next step at all.
 */
export function nextStep(status: SetupStatus): SetupStep | null {
  return status.steps.find((step) => step.state === 'next') ?? null;
}
