import { describe, expect, it } from 'vitest';

import type { Employee, ReadinessQuestion, ReadinessRunStatus } from '@/api/contracts/employees';

import { AFTER_HIRE_WINDOW_MS, readinessAnswered, readinessGaps, readinessRun } from './readiness';

const q = (
  question: string,
  coverage: ReadinessQuestion['coverage'],
  answered = false,
): ReadinessQuestion => ({
  id: null,
  question,
  coverage,
  reason: '',
  answered,
});

describe('★★ H7 - the questions it is not ready for', () => {
  it('none first, then partial, each in the report’s order; full is no gap', () => {
    expect(
      readinessGaps([
        q('a', 'partial'),
        q('b', 'full'),
        q('c', 'none'),
        q('d', 'partial'),
        q('e', 'none'),
      ]).map((g) => g.question),
    ).toEqual(['c', 'e', 'a', 'd']);
  });
});

const now = Date.parse('2026-10-13T12:00:00Z');
const employee = (over: Partial<Employee> = {}) =>
  ({
    status: 'ACTIVE',
    readinessReport: null,
    updatedAt: new Date(now - 30_000).toISOString(),
    ...over,
  }) as Employee;
const status = (over: Partial<ReadinessRunStatus>): ReadinessRunStatus => ({
  readinessStartedAt: null,
  readinessFinishedAt: null,
  readinessError: null,
  ...over,
});

describe('★★ H7 - the run, from its stored status (Backend 94ccaead)', () => {
  it('running is running - even long after the hire, the server decides when it died', () => {
    expect(
      readinessRun(
        employee({ updatedAt: '2026-01-01T00:00:00Z' }),
        status({ readinessStatus: 'running' }),
        now,
      ),
    ).toEqual({ state: 'running' });
  });

  it('★ failed says which failure; a code we do not know is "other", never a blank', () => {
    for (const code of [
      'agent_not_found',
      'llm_unavailable',
      'bad_model_output',
      'internal_error',
      'persist_failed',
      'timed_out',
    ]) {
      expect(
        readinessRun(employee(), status({ readinessStatus: 'failed', readinessError: code }), now),
      ).toEqual({ state: 'failed', failure: code });
    }
    expect(
      readinessRun(employee(), status({ readinessStatus: 'failed', readinessError: 'new' }), now),
    ).toEqual({ state: 'failed', failure: 'other' });
    expect(readinessRun(employee(), status({ readinessStatus: 'failed' }), now)).toEqual({
      state: 'failed',
      failure: 'other',
    });
  });

  it('★★ done, or never recorded (null): idle - the window is NOT applied to a server that says', () => {
    // Just hired, no report: a stored null means no run was recorded, not "running".
    expect(readinessRun(employee(), status({ readinessStatus: null }), now)).toEqual({
      state: 'idle',
    });
    expect(readinessRun(employee(), status({ readinessStatus: 'done' }), now)).toEqual({
      state: 'idle',
    });
  });
});

describe('★ an older server, or an unread status: the belief after a hire', () => {
  const older = status({}); // readinessStatus absent
  const at = (ms: number, over: Partial<Employee> = {}) =>
    readinessRun(employee({ updatedAt: new Date(now - ms).toISOString(), ...over }), older, now)
      .state;

  it('no report, working, changed within the window: running; past it, idle', () => {
    expect(at(30_000)).toBe('running');
    expect(at(AFTER_HIRE_WINDOW_MS - 1)).toBe('running');
    expect(at(AFTER_HIRE_WINDOW_MS)).toBe('idle');
    // A server clock a little ahead of ours still counts.
    expect(at(-5_000)).toBe('running');
    // The status could not be read at all: the same belief.
    expect(readinessRun(employee(), null, now).state).toBe('running');
  });

  it('a report, a draft, a paused employee, or no time: idle', () => {
    expect(at(1_000, { readinessReport: {} as Employee['readinessReport'] })).toBe('idle');
    expect(at(1_000, { status: 'DRAFT' })).toBe('idle');
    expect(at(1_000, { status: 'PAUSED' })).toBe('idle');
    expect(readinessRun(employee({ updatedAt: null }), older, now).state).toBe('idle');
    expect(readinessRun(employee({ updatedAt: 'garbage' }), older, now).state).toBe('idle');
  });
});

describe('★★ E2 - a question a person answered is no gap', () => {
  it('answered is left out of the gaps, whatever its coverage, and listed on its own', () => {
    const questions = [
      q('a', 'none', true),
      q('b', 'none'),
      q('c', 'partial', true),
      q('d', 'full', true),
    ];
    expect(readinessGaps(questions).map((g) => g.question)).toEqual(['b']);
    expect(readinessAnswered(questions).map((g) => g.question)).toEqual(['a', 'c', 'd']);
  });
});
