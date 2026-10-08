import { describe, expect, it } from 'vitest';

import { packName } from './pack-name';

const count = () => '1,000 קרדיטים';

describe('★ a pack’s name in the reader’s language (14" sweep: "credits" under a Hebrew page)', () => {
  it('Hebrew: nameHe when there is one; else the count in Hebrew - never the English name', () => {
    expect(packName({ name: '1,000 credits', nameHe: 'חבילת 1,000' }, 'he', count)).toBe(
      'חבילת 1,000',
    );
    expect(packName({ name: '1,000 credits', nameHe: null }, 'he', count)).toBe('1,000 קרדיטים');
    expect(packName({ name: '1,000 credits', nameHe: '  ' }, 'he', count)).toBe('1,000 קרדיטים');
  });

  it('English keeps the shelf’s name', () => {
    expect(packName({ name: '1,000 credits', nameHe: 'חבילת 1,000' }, 'en', count)).toBe(
      '1,000 credits',
    );
  });
});
