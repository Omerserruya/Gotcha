import type { TenantGate } from '@/api/client/tenant-gate';
import type { SetupStatus, SetupStep } from '@/api/contracts/setup';

/**
 * The derivations behind the day-one block.
 *
 * Pure, so the arithmetic the header states out loud - how many are done, how
 * long the rest takes - can be tested without a translation runtime.
 */

/**
 * Where each step's action goes.
 *
 * "Every step completes inside the sheet it opens - none of them drop the user
 * into Settings and abandon them there." Until those sheets exist, a step
 * points at the page that owns it rather than at a route that does not exist.
 */
/**
 * Where each step is completed - the screen whose write the server checks
 * (`services/auth/src/routes/setup-state.ts`). `null`: no screen sets it.
 *
 *   handover_rules   done when the policy has `escalationKeywords` or
 *                    `blockedTopics`. Only Workspace's "Never say" writes
 *                    the second, and that is not a handover rule.
 *   approval_limits  the policy's limits, OR - since backend b3411ed4 - an
 *                    action tool the merchant set to Ask me on 10 (a seed
 *                    does not count). So 10 completes it.
 *   test_conversation  a conversation marked `isTest` - no screen makes one.
 */
const DESTINATIONS: Record<string, string | null> = {
  connect_channel: '/settings/channels',
  connect_store: '/settings/systems',
  add_knowledge: '/studio/knowledge?add=1',
  hire_employee: '/studio/employees?hire=1',
  handover_rules: null,
  approval_limits: '/studio/capabilities',
  test_conversation: null,
  invite_team: '/settings/people',
};

/** Steps with their own wording. An unrecognised id is shown, never hidden. */
const KNOWN_STEPS = new Set(Object.keys(DESTINATIONS));

/** `null` when no screen completes the step. */
export function stepDestination(id: string): string | null {
  return DESTINATIONS[id] ?? null;
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
 * two, the first wins rather than the block raising both - two "do this next"
 * steps is not a next step at all.
 */
export function nextStep(status: SetupStatus): SetupStep | null {
  return status.steps.find((step) => step.state === 'next') ?? null;
}

/** Which face Home shows. */
export type HomeFace = 'day-one' | 'gated' | 'ordinary';

/**
 * Day one outranks the tenant gate, and the order matters.
 *
 * A workspace still onboarding fails every paid endpoint with a `TENANT_`
 * code, so a gate is reported on exactly the mornings the day-one block exists
 * for. Letting the gate win would replace the block that walks someone through
 * setup with a notice telling them setup is unfinished - true, useless, and a
 * dead end on the one screen that could fix it.
 *
 * A missing `setup` is the guard rather than a special case: a workspace whose
 * admin has not finished first-time setup cannot read setup state either, and
 * falls through to the notice, which is the right answer there.
 */
export function homeFace(input: { setup: SetupStatus | null; gate: TenantGate | null }): HomeFace {
  if (input.setup !== null && !input.setup.isLive) return 'day-one';
  if (input.gate) return 'gated';
  return 'ordinary';
}
