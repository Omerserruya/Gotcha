import { describe, expect, it } from 'vitest';

import { ltr } from './bidi';

const LRI = String.fromCharCode(0x2066);
const PDI = String.fromCharCode(0x2069);

describe('ltr - a handle as one left-to-right island', () => {
  it('wraps the value in LRI…PDI', () => {
    expect(ltr('+972 54 568 0665')).toBe(`${LRI}+972 54 568 0665${PDI}`);
  });

  it('nothing for nothing - so `ltr(x) ?? fallback` falls back', () => {
    expect(ltr(null)).toBeNull();
    expect(ltr('')).toBeNull();
  });
});
