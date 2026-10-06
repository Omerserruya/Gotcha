import { describe, expect, it } from 'vitest';

import { dateIn, endOfDate, expiresAtOf } from './grant-end';

const IL = 'Asia/Jerusalem';

describe('★★ 12e - an end is the last second of a day in the workspace’s zone', () => {
  it('the day’s own offset: summer +3, winter +2', () => {
    expect(endOfDate('2026-10-05', IL)).toBe('2026-10-05T20:59:59.000Z');
    expect(endOfDate('2026-12-15', IL)).toBe('2026-12-15T21:59:59.000Z');
  });

  it('"7 days" counts calendar days there - late at night UTC is already tomorrow in Israel', () => {
    // 22:30Z on the 5th is 01:30 on the 6th in Israel.
    const now = new Date('2026-10-05T22:30:00Z');
    expect(dateIn(IL, now)).toBe('2026-10-06');
    expect(expiresAtOf({ kind: 'days', days: 7 }, IL, now)).toBe('2026-10-13T20:59:59.000Z');
  });

  it('across the change back to winter time, 30 days ends at that day’s 23:59:59', () => {
    const now = new Date('2026-10-06T09:00:00Z');
    expect(expiresAtOf({ kind: 'days', days: 30 }, IL, now)).toBe('2026-11-05T21:59:59.000Z');
  });

  it('no end date is null; a date not yet picked is nothing to send', () => {
    expect(expiresAtOf({ kind: 'none' }, IL)).toBeNull();
    expect(expiresAtOf({ kind: 'date', date: '' }, IL)).toBeNull();
  });
});
