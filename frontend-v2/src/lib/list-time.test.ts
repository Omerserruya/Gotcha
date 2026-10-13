import { createFormatter } from 'next-intl';
import { describe, expect, it } from 'vitest';

import { listTime } from './list-time';

/** I4 (Omer, 2026-10-13), with the app's own formatter in the workspace's zone. */
const he = createFormatter({ locale: 'he', timeZone: 'Asia/Jerusalem' });
const en = createFormatter({ locale: 'en', timeZone: 'Asia/Jerusalem' });
// Tuesday 13 October 2026, 12:00 in Jerusalem (UTC+3).
const NOW = new Date('2026-10-13T09:00:00.000Z');

describe('★★ a conversation’s time in a list', () => {
  it('★ under 24 hours: the time, 24-hour', () => {
    expect(listTime('2026-10-13T06:43:00.000Z', NOW, he)).toBe('09:43');
    expect(listTime('2026-10-12T13:43:00.000Z', NOW, he)).toBe('16:43');
    expect(listTime('2026-10-12T13:43:00.000Z', NOW, en)).toBe('16:43');
  });

  it('★ the boundary is 24 hours elapsed, not midnight', () => {
    // Yesterday 12:01 is 23h59m ago - still a time.
    expect(listTime('2026-10-12T09:01:00.000Z', NOW, he)).toBe('12:01');
    // Exactly 24 hours ago - a weekday (Monday).
    expect(listTime('2026-10-12T09:00:00.000Z', NOW, he)).toBe('יום ב׳');
  });

  it('★★ 24 hours to 7 days: the weekday', () => {
    expect(listTime('2026-10-11T09:00:00.000Z', NOW, he)).toBe('יום א׳');
    expect(listTime('2026-10-07T10:00:00.000Z', NOW, he)).toBe('יום ד׳');
    expect(listTime('2026-10-07T10:00:00.000Z', NOW, en)).toBe('Wed');
    // 6 days 18 hours ago - still this week (Tuesday the 6th, 18:00 there).
    expect(listTime('2026-10-06T15:00:00.000Z', NOW, he)).toBe('יום ג׳');
  });

  it('★★ older: the date with dots, the year only when it is another one', () => {
    expect(listTime('2026-10-06T09:00:00.000Z', NOW, he)).toBe('06.10');
    expect(listTime('2026-10-06T09:00:00.000Z', NOW, en)).toBe('06.10');
    expect(listTime('2025-10-12T09:00:00.000Z', NOW, he)).toBe('12.10.25');
  });

  it('★ the day is the workspace’s: 23:30 in Jerusalem is that day there', () => {
    // 2026-10-01 20:30Z is 23:30 on the 1st in Jerusalem, the 1st in UTC too;
    // 2026-10-01 22:30Z is 01:30 on the 2nd in Jerusalem.
    expect(listTime('2026-10-01T22:30:00.000Z', NOW, he)).toBe('02.10');
  });

  it('a time a little ahead of ours (clock skew) is a time; nonsense is nothing', () => {
    expect(listTime('2026-10-13T09:02:00.000Z', NOW, he)).toBe('12:02');
    expect(listTime('not a date', NOW, he)).toBeNull();
  });
});
