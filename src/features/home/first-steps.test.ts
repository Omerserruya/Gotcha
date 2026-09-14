import { describe, expect, it } from 'vitest';

import type { SetupStatus, SetupStep } from '@/api/contracts/setup';

import { homeFace, nextStep, setupProgress, stepCopyKey, stepDestination } from './first-steps';

const step = (overrides: Partial<SetupStep> & { id: string }): SetupStep => ({
  state: 'waiting',
  completedAt: null,
  blockedBy: [],
  estimateMinutes: 5,
  ...overrides,
});

const status = (steps: SetupStep[]): SetupStatus => ({ steps, isLive: false });

describe('setupProgress', () => {
  it('counts what is done and sums only what is left', () => {
    const progress = setupProgress(
      status([
        step({ id: 'connect_channel', state: 'done', estimateMinutes: 5 }),
        step({ id: 'add_knowledge', state: 'done', estimateMinutes: 10 }),
        step({ id: 'hire_employee', state: 'next', estimateMinutes: 4 }),
        step({ id: 'handover_rules', state: 'blocked', estimateMinutes: 5 }),
      ]),
    );
    expect(progress.done).toBe(2);
    expect(progress.total).toBe(4);
    // The two finished steps' 15 minutes are not "left".
    expect(progress.minutesLeft).toBe(9);
    expect(progress.isComplete).toBe(false);
  });

  it('is not complete when there are no steps at all', () => {
    // An empty response must not read as a finished setup.
    expect(setupProgress(status([])).isComplete).toBe(false);
  });

  it('is complete only when every step is done', () => {
    const progress = setupProgress(
      status([step({ id: 'a', state: 'done' }), step({ id: 'b', state: 'done' })]),
    );
    expect(progress.isComplete).toBe(true);
    expect(progress.minutesLeft).toBe(0);
  });
});

describe('nextStep', () => {
  it('finds the one step the server marked', () => {
    expect(
      nextStep(status([step({ id: 'a', state: 'done' }), step({ id: 'b', state: 'next' })]))?.id,
    ).toBe('b');
  });

  /*
   * The server promises exactly one. Two would mean no next step at all, so
   * the first wins rather than the block raising both out of the list.
   */
  it('takes the first when a response carries more than one', () => {
    expect(
      nextStep(status([step({ id: 'a', state: 'next' }), step({ id: 'b', state: 'next' })]))?.id,
    ).toBe('a');
  });

  it('is null when nothing is next', () => {
    expect(nextStep(status([step({ id: 'a', state: 'done' })]))).toBeNull();
  });
});

describe('step copy', () => {
  it('has wording for every step the backend defines', () => {
    for (const id of [
      'connect_channel',
      'connect_store',
      'add_knowledge',
      'hire_employee',
      'handover_rules',
      'approval_limits',
      'test_conversation',
      'invite_team',
    ]) {
      expect(stepCopyKey(id)).toBe(id);
    }
  });

  /*
   * A step nobody has written copy for is shown by its id, not hidden: a
   * missing row changes what setup appears to involve.
   */
  it('returns null for an unknown step rather than inventing a key', () => {
    expect(stepCopyKey('verify_domain')).toBeNull();
    expect(stepDestination('verify_domain')).toBe('/settings');
  });
});

describe('homeFace', () => {
  const live: SetupStatus = { steps: [step({ id: 'a', state: 'done' })], isLive: true };
  const setupPending: SetupStatus = { steps: [step({ id: 'a' })], isLive: false };
  const gate = {
    code: 'TENANT_ONBOARDING_REQUIRED',
    tenantStatus: 'PENDING_ONBOARDING',
    checkoutPath: null,
  };

  /*
   * The regression this exists for. A workspace still onboarding fails every
   * paid endpoint with a TENANT_ code, so a gate is reported on exactly the
   * mornings day one is for. Showing the notice there replaces the block that
   * walks someone through setup with one that tells them setup is unfinished.
   */
  it('shows day one even when the tenant gate has fired', () => {
    expect(homeFace({ setup: setupPending, gate })).toBe('day-one');
  });

  it('shows the gate when the workspace is live but locked out', () => {
    expect(
      homeFace({
        setup: live,
        gate: { code: 'TENANT_PLAN_REQUIRED', tenantStatus: 'ACTIVE', checkoutPath: null },
      }),
    ).toBe('gated');
  });

  /*
   * An admin who has not finished first-time setup cannot read setup state
   * either, so there is nothing to render a block from and the notice is the
   * right answer.
   */
  it('falls back to the gate when setup state is unreadable', () => {
    expect(homeFace({ setup: null, gate })).toBe('gated');
  });

  it('is the ordinary screen for a live workspace with no gate', () => {
    expect(homeFace({ setup: live, gate: null })).toBe('ordinary');
  });

  /* A failed setup call is not a live workspace, and not day one either. */
  it('does not claim day one when setup simply failed to load', () => {
    expect(homeFace({ setup: null, gate: null })).toBe('ordinary');
  });
});
