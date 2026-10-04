import { describe, expect, it } from 'vitest';

import { localInstant, parseClock, parseDay, showDay } from './clock-entry';

describe('★★ day-first, 24-hour entry', () => {
  it.each([
    ['9', '09:00'],
    ['21', '21:00'],
    ['9:30', '09:30'],
    ['09.30', '09:30'],
    ['930', '09:30'],
    ['2130', '21:30'],
    ['0000', '00:00'],
    ['24', null],
    ['24:00', null],
    ['9:60', null],
    ['9:5', null],
    ['9pm', null],
    ['', null],
  ])('parseClock(%j) → %j', (raw, out) => {
    expect(parseClock(raw)).toBe(out);
  });

  it.each([
    ['4/10/2026', '2026-10-04'],
    ['04.10.26', '2026-10-04'],
    ['31-12-2026', '2026-12-31'],
    ['29/02/2028', '2028-02-29'],
    ['29/02/2027', null],
    ['31/04/2026', null],
    ['10/32/2026', null],
    ['2026-10-04', null],
  ])('parseDay(%j) → %j — day first, a real day only', (raw, out) => {
    expect(parseDay(raw)).toBe(out);
  });

  it('shows the stored day day-first; the instant is local', () => {
    expect(showDay('2026-10-04')).toBe('04/10/2026');
    expect(showDay('')).toBe('');
    expect(new Date(localInstant('2026-10-04', '21:30')).getHours()).toBe(21);
    expect(new Date(localInstant('2026-10-04', '21:30')).getDate()).toBe(4);
  });
});
