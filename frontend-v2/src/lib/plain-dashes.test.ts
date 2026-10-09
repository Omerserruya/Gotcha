import { describe, expect, it } from 'vitest';

import { plainDashes } from './plain-dashes';

const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);

describe('plainDashes: model text with plain hyphens', () => {
  it.each([
    [`Sorry, Dana ${EM} that's far too long.`, "Sorry, Dana - that's far too long."],
    [`far too long${EM}I've asked`, "far too long - I've asked"],
    [`Open 09:00${EN}18:00`, 'Open 09:00-18:00'],
    [EM, '-'],
    [`${EM} starts here`, '- starts here'],
    ['nothing to change - already plain', 'nothing to change - already plain'],
  ])('%s → %s', (input, output) => {
    expect(plainDashes(input)).toBe(output);
  });

  it('keeps null and empty as they are', () => {
    expect(plainDashes(null)).toBeNull();
    expect(plainDashes('')).toBe('');
  });
});
