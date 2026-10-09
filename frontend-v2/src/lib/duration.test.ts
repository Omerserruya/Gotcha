import { describe, expect, it } from 'vitest';

import { wholeUnit } from './duration';

const MIN = 60_000;

describe('★★ a duration in the largest unit it fills whole', () => {
  it.each([
    [1440 * MIN, 'days', 1],
    [2880 * MIN, 'days', 2],
    [120 * MIN, 'hours', 2],
    [24 * 60 * MIN, 'days', 1],
    [90 * MIN, 'minutes', 90],
    [1500 * MIN, 'hours', 25],
    [30 * MIN, 'minutes', 30],
    [1 * MIN, 'minutes', 1],
    [10_000, 'minutes', 1],
  ] as const)('%d ms → %s %d', (ms, unit, count) => {
    expect(wholeUnit(ms)).toEqual({ unit, count });
  });
});
