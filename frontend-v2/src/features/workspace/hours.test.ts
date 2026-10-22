import { describe, expect, it } from 'vitest';

import type { Workspace } from '@/api/contracts/workspace';

import { hoursPatch, summariseWeek, weekOf } from './hours';

const workspace = (schedule: Record<string, unknown> | null): Workspace =>
  ({
    languages: [],
    hours: schedule
      ? { enabled: true, schedule, aiOutsideHours: 'active', outsideHoursHandoffMessage: '' }
      : null,
  }) as unknown as Workspace;

const nine = { enabled: true, open: '09:00', close: '18:00' };
const short = { enabled: true, open: '09:00', close: '13:00' };

describe('weekOf', () => {
  it('reads a missing day as closed rather than dropping it', () => {
    const week = weekOf(workspace({ sunday: nine }));
    expect(week.sunday.enabled).toBe(true);
    expect(week.saturday.enabled).toBe(false);
    expect(Object.keys(week)).toHaveLength(7);
  });

  /*
   * A day flagged enabled with no times cannot be honoured - "open, from
   * unknown to unknown" is not an opening hour. Closed is the safe reading:
   * the AI refusing to promise is better than the AI inventing a time.
   */
  it('treats an enabled day with no times as closed', () => {
    expect(weekOf(workspace({ monday: { enabled: true } })).monday.enabled).toBe(false);
  });

  it('survives a workspace with no hours at all', () => {
    expect(weekOf(null).sunday.enabled).toBe(false);
    expect(weekOf(workspace(null)).sunday.enabled).toBe(false);
  });
});

describe('summariseWeek', () => {
  it('collapses a run and lists the exceptions, as the design writes it', () => {
    const summary = summariseWeek(
      weekOf(
        workspace({
          sunday: nine,
          monday: nine,
          tuesday: nine,
          wednesday: nine,
          thursday: nine,
          friday: short,
          saturday: { enabled: false },
        }),
      ),
    );
    expect(summary.runs).toHaveLength(2);
    expect(summary.runs[0]?.days).toEqual(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday']);
    expect(summary.runs[1]?.days).toEqual(['friday']);
    expect(summary.closed).toEqual(['saturday']);
  });

  /*
   * Two stretches with identical hours but a closed day between them are two
   * runs. "Sun-Fri" would be a claim the business is open on Wednesday.
   */
  it('does not bridge a run across a closed day', () => {
    const summary = summariseWeek(
      weekOf(
        workspace({ sunday: nine, monday: nine, wednesday: { enabled: false }, thursday: nine }),
      ),
    );
    expect(summary.runs.map((r) => r.days)).toEqual([['sunday', 'monday'], ['thursday']]);
  });

  it('does not collapse days whose times differ at all', () => {
    const summary = summariseWeek(
      weekOf(workspace({ sunday: nine, monday: { enabled: true, open: '09:10', close: '18:00' } })),
    );
    expect(summary.runs).toHaveLength(2);
  });

  it('reports a week with nothing open', () => {
    expect(summariseWeek(weekOf(null)).isEmpty).toBe(true);
  });
});

describe('hoursPatch', () => {
  /*
   * The server REPLACES this setting. A partial week would be stored verbatim
   * and the missing days would simply vanish.
   */
  it('always sends a complete week', () => {
    const patch = hoursPatch(weekOf(workspace({ sunday: nine })), null);
    expect(Object.keys(patch.schedule as object)).toHaveLength(7);
  });

  /*
   * These two live in the same setting and are not on this screen. Defaulting
   * them here would silently switch the AI's out-of-hours behaviour whenever
   * someone edited their opening times.
   */
  it('carries the out-of-hours policy rather than resetting it', () => {
    const patch = hoursPatch(weekOf(null), {
      enabled: true,
      aiOutsideHours: 'silent',
      outsideHoursHandoffMessage: 'We reopen Sunday.',
    } as Workspace['hours']);
    expect(patch.aiOutsideHours).toBe('silent');
    expect(patch.outsideHoursHandoffMessage).toBe('We reopen Sunday.');
  });

  it('sends a closed day with no times', () => {
    const patch = hoursPatch(weekOf(workspace({ sunday: nine })), null);
    expect((patch.schedule as Record<string, unknown>).saturday).toEqual({ enabled: false });
  });
});
