import { describe, expect, it } from 'vitest';

import { initials, waitLabel } from './queue-row';

/** Stands in for next-intl: returns the key and the count it was given. */
const t = (key: string, values: Record<string, number>) => `${key}:${values.count}`;

describe('waitLabel', () => {
  const now = Date.parse('2026-09-08T12:00:00.000Z');
  const minutesAgo = (m: number) => new Date(now - m * 60_000).toISOString();

  it('reads in minutes below the hour and in hours above it', () => {
    expect(waitLabel(minutesAgo(12), now, t)).toBe('wait.minutes:12');
    expect(waitLabel(minutesAgo(59), now, t)).toBe('wait.minutes:59');
    expect(waitLabel(minutesAgo(60), now, t)).toBe('wait.hours:1');
    expect(waitLabel(minutesAgo(200), now, t)).toBe('wait.hours:3');
  });

  /*
   * Services do not share a clock. A row timestamped a second into the future
   * must read as "0m", never as a negative wait.
   */
  it('clamps a future timestamp rather than rendering a negative wait', () => {
    expect(waitLabel(new Date(now + 30_000).toISOString(), now, t)).toBe('wait.minutes:0');
  });

  it('renders nothing for an unparseable timestamp', () => {
    expect(waitLabel('not a date', now, t)).toBe('');
  });
});

describe('initials', () => {
  it('takes at most two', () => {
    expect(initials('Dana Cohen')).toBe('DC');
    expect(initials('Yael')).toBe('Y');
    expect(initials('Ana Maria Perez Diaz')).toBe('AM');
  });

  /*
   * A conversation is not guaranteed a contact record. Deriving a letter from
   * a phone number would put an initial on screen for a name the product does
   * not know.
   */
  it('is empty when there is no name, rather than inventing one', () => {
    expect(initials(null)).toBe('');
    expect(initials(undefined)).toBe('');
    expect(initials('   ')).toBe('');
  });
});
