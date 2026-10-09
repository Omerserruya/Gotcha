import { describe, expect, it } from 'vitest';

import { displayHandle } from './phone';

describe('displayHandle', () => {
  it('★★ the measured case: an Israeli WhatsApp number in display form', () => {
    expect(displayHandle('WHATSAPP', '972545680665')).toBe('+972 54 568 0665');
  });

  it('keeps a leading + it was given, without doubling it', () => {
    expect(displayHandle('WHATSAPP', '+972524189930')).toBe('+972 52 418 9930');
  });

  it('groups NANP, and leaves an unknown plan as one run with its +', () => {
    expect(displayHandle('VOICE', '14155550100')).toBe('+1 415 555 0100');
    expect(displayHandle('WHATSAPP', '447700900123')).toBe('+447700900123');
  });

  it('leaves non-phone channels and non-numbers alone', () => {
    expect(displayHandle('INSTAGRAM', '972545680665')).toBe('972545680665');
    expect(displayHandle('WHATSAPP', 'lid:abc')).toBe('lid:abc');
    expect(displayHandle('WHATSAPP', '1234')).toBe('1234');
  });
});
