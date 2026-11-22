import { describe, expect, it } from 'vitest';

import { senderRuleOf } from './relevance-mark';

/** ★★ What a hand mark did to its sender: only when the response says so. */
describe('★★ senderRuleOf', () => {
  it.each([
    [{ senderRule: 'applied' }, 'applied'],
    [{ senderRule: 'lifted' }, 'lifted'],
  ] as const)('%j reads as %s', (raw, want) => {
    expect(senderRuleOf(raw)).toBe(want);
  });

  it.each([
    {},
    { ok: true },
    { senderRule: null },
    { senderRule: 'APPLIED' },
    { senderRule: 'none' },
    { senderRule: true },
    null,
    'applied',
    [],
  ])('★ %j is not said: no line, never a guess', (raw) => {
    expect(senderRuleOf(raw)).toBeNull();
  });
});
