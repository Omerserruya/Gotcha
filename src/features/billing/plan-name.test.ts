import { describe, expect, it } from 'vitest';

import { planNameFor, type Plan } from '@/api/contracts/billing';

/**
 * `ai_voice` is a plan KEY. It shipped as the most prominent line on the
 * billing screen and was caught in a screenshot — the same class as rendering
 * a cuid where an object name belongs, in a more visible place.
 */
const PLANS: Plan[] = [
  { key: 'ai_voice', name: 'AI Voice', nameHe: 'קול AI' },
  { key: 'foundation', name: 'Foundation', nameHe: null },
];

describe('planNameFor', () => {
  it('resolves the key to a name a customer can read', () => {
    expect(planNameFor(PLANS, 'ai_voice', 'en')).toBe('AI Voice');
  });

  it('uses the Hebrew name for a Hebrew reader', () => {
    // A key cannot be translated; this is why the lookup exists at all.
    expect(planNameFor(PLANS, 'ai_voice', 'he')).toBe('קול AI');
  });

  it('falls back to the English name when there is no Hebrew one', () => {
    // Rather than rendering a blank where the plan name belongs.
    expect(planNameFor(PLANS, 'foundation', 'he')).toBe('Foundation');
  });

  it('returns null for a plan the list does not contain', () => {
    // The caller decides; on the billing screen the key is better than a gap,
    // because an unrecognised plan is still the one being paid for.
    expect(planNameFor(PLANS, 'retired_legacy', 'en')).toBeNull();
  });

  it('returns null rather than guessing when there is no key', () => {
    expect(planNameFor(PLANS, null, 'en')).toBeNull();
    expect(planNameFor([], 'ai_voice', 'en')).toBeNull();
  });
});
