import { describe, expect, it } from 'vitest';

import { greetingKey, rowTone } from './mobile-home';

describe('greetingKey', () => {
  it('follows the hour, as the website does', () => {
    expect(greetingKey(8, false, false)).toBe('morning');
    expect(greetingKey(12, false, false)).toBe('afternoon');
    expect(greetingKey(17, false, false)).toBe('afternoon');
    expect(greetingKey(18, false, false)).toBe('evening');
  });

  it('has its own words for a quiet day and for a name', () => {
    expect(greetingKey(9, true, false)).toBe('quiet.morning');
    expect(greetingKey(9, false, true)).toBe('named.morning');
    expect(greetingKey(20, true, true)).toBe('named.quiet.evening');
  });
});

describe('rowTone', () => {
  it('marks only the angry, the valuable and the blocked', () => {
    expect(rowTone('FRUSTRATED')).toBe('urgent');
    expect(rowTone('COMPLAINT')).toBe('urgent');
    expect(rowTone('HIGH_INTENT')).toBe('opportunity');
    expect(rowTone('WAITING_EXTERNAL')).toBe('blocked');
  });

  it('leaves everything else neutral, never guessed', () => {
    expect(rowTone('REFUND')).toBe('neutral');
    expect(rowTone('SOMETHING_NEW')).toBe('neutral');
    expect(rowTone('toString')).toBe('neutral');
  });
});
