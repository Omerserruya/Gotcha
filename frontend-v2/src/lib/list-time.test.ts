import { createFormatter, createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';

import enInbox from '@/i18n/messages/en/inbox.json';
import heInbox from '@/i18n/messages/he/inbox.json';

import { type DateFormatter, listTime } from './list-time';

/** I4 (Omer, 2026-10-13), with the app's own formatter in the workspace's zone. */
const heFormat = createFormatter({ locale: 'he', timeZone: 'Asia/Jerusalem' });
const enFormat = createFormatter({ locale: 'en', timeZone: 'Asia/Jerusalem' });
// The catalogues' own copy, so a wrong key or a broken plural fails here.
const heT = createTranslator({ locale: 'he', messages: { inbox: heInbox }, namespace: 'inbox' });
const enT = createTranslator({ locale: 'en', messages: { inbox: enInbox }, namespace: 'inbox' });
type Locale = { format: DateFormatter; daysAgo: (days: number) => string };
const he: Locale = { format: heFormat, daysAgo: (days) => heT('queue.daysAgo', { days }) };
const en: Locale = { format: enFormat, daysAgo: (days) => enT('queue.daysAgo', { days }) };
const at = (iso: string, now: Date, l: Locale) => listTime(iso, now, l.format, l.daysAgo);
// Tuesday 13 October 2026, 12:00 in Jerusalem (UTC+3).
const NOW = new Date('2026-10-13T09:00:00.000Z');

describe('★★ a conversation’s time in a list', () => {
  it('★ under 24 hours: the time, 24-hour', () => {
    expect(at('2026-10-13T06:43:00.000Z', NOW, he)).toBe('09:43');
    expect(at('2026-10-12T13:43:00.000Z', NOW, he)).toBe('16:43');
    expect(at('2026-10-12T13:43:00.000Z', NOW, en)).toBe('16:43');
  });

  it('★ the boundary is 24 hours elapsed, not midnight', () => {
    // Yesterday 12:01 is 23h59m ago - still a time.
    expect(at('2026-10-12T09:01:00.000Z', NOW, he)).toBe('12:01');
    // Exactly 24 hours ago - yesterday.
    expect(at('2026-10-12T09:00:00.000Z', NOW, he)).toBe('אתמול');
    expect(at('2026-10-12T09:00:00.000Z', NOW, en)).toBe('Yesterday');
  });

  it('★★ F1 (Omer, 2026-11-09): past 24 hours, days ago up to 6', () => {
    expect(at('2026-10-11T09:00:00.000Z', NOW, he)).toBe('לפני 2 ימים');
    expect(at('2026-10-10T09:00:00.000Z', NOW, he)).toBe('לפני 3 ימים');
    expect(at('2026-10-07T10:00:00.000Z', NOW, he)).toBe('לפני 6 ימים');
    expect(at('2026-10-11T09:00:00.000Z', NOW, en)).toBe('2 days ago');
    expect(at('2026-10-07T10:00:00.000Z', NOW, en)).toBe('6 days ago');
  });

  it('★★ days are calendar days in the workspace’s zone, not 24-hour blocks', () => {
    // 23:00 on Sunday the 11th in Jerusalem, read Tuesday 12:00: 37 hours,
    // and two days back on the calendar - not "yesterday".
    expect(at('2026-10-11T20:00:00.000Z', NOW, he)).toBe('לפני 2 ימים');
    // 00:30 Monday the 12th in Jerusalem (21:30Z on the 11th): yesterday there.
    expect(at('2026-10-11T21:30:00.000Z', NOW, he)).toBe('אתמול');
  });

  it('★ the cutover: 7 calendar days back is a date', () => {
    // Tuesday the 6th, 18:00 in Jerusalem - 6 days 18 hours ago, 7 days back.
    expect(at('2026-10-06T15:00:00.000Z', NOW, he)).toBe('06.10');
  });

  it('★★ older: the date with dots, the year only when it is another one', () => {
    expect(at('2026-10-06T09:00:00.000Z', NOW, he)).toBe('06.10');
    expect(at('2026-10-06T09:00:00.000Z', NOW, en)).toBe('06.10');
    expect(at('2025-10-12T09:00:00.000Z', NOW, he)).toBe('12.10.25');
  });

  it('★ the day is the workspace’s: 23:30 in Jerusalem is that day there', () => {
    // 2026-10-01 20:30Z is 23:30 on the 1st in Jerusalem, the 1st in UTC too;
    // 2026-10-01 22:30Z is 01:30 on the 2nd in Jerusalem.
    expect(at('2026-10-01T22:30:00.000Z', NOW, he)).toBe('02.10');
  });

  it('a time a little ahead of ours (clock skew) is a time; nonsense is nothing', () => {
    expect(at('2026-10-13T09:02:00.000Z', NOW, he)).toBe('12:02');
    expect(at('not a date', NOW, he)).toBeNull();
  });
});
