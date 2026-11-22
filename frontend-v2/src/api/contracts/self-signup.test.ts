import { describe, expect, it } from 'vitest';

import {
  domainJoinSchema,
  signUpBody,
  signUpConfigSchema,
  signUpFieldOf,
  cardRequired,
  refusedFieldOf,
  signUpSettingsSchema,
} from './self-signup';

describe('★★ self sign-up’s wire (ASSUMED until Backend’s shape)', () => {
  it('★ the config: odd or absent is closed, and the trial numbers are optional', () => {
    expect(
      signUpConfigSchema.parse({ enabled: true, trialDays: 14, cardRequiredAfterDays: 14 }),
    ).toEqual({ enabled: true, trialDays: 14, cardRequiredAfterDays: 14 });
    expect(signUpConfigSchema.parse({ enabled: 'yes' })).toEqual({
      enabled: false,
      trialDays: null,
      cardRequiredAfterDays: null,
    });
    expect(signUpConfigSchema.parse({ enabled: true, trialDays: -1 }).trialDays).toBeNull();
  });

  it('★★ the body: trimmed, the setup screen’s Terms fields, the language', () => {
    expect(
      signUpBody({ name: ' Maya ', email: ' m@a.co ', businessName: ' Aviv ' }, 'he', ' קראתי '),
    ).toEqual({
      name: 'Maya',
      email: 'm@a.co',
      businessName: 'Aviv',
      terms: true,
      privacy: true,
      locale: 'he',
      capturedText: 'קראתי',
      website: '',
    });
    // The honeypot goes as the hidden field held it.
    expect(signUpBody({ name: 'a', email: 'b', businessName: 'c' }, 'en', 'x', 'bot').website).toBe(
      'bot',
    );
  });

  it('★ a 400’s fields map names the first field of the form', () => {
    expect(refusedFieldOf({ website: 'invalid', email: 'invalid' })).toBe('email');
    expect(refusedFieldOf({ password: 'x' })).toBeNull();
    expect(refusedFieldOf(undefined)).toBeNull();
  });

  it('★ a refusal names a field from the form, or none', () => {
    expect(signUpFieldOf('email')).toBe('email');
    expect(signUpFieldOf('password')).toBeNull();
    expect(signUpFieldOf(undefined)).toBeNull();
  });

  it('★ the console’s settings: three numbers, per-number bounds, the env switch', () => {
    const read = signUpSettingsSchema.parse({
      enabled: true,
      trialDays: 14,
      cardRequiredAfterDays: 14,
      trialCredits: 5000,
      envEnabled: false,
      bounds: {
        trialDays: { min: 1, max: 60 },
        cardRequiredAfterDays: { min: 1, max: 60 },
        trialCredits: { min: 500, max: 20000 },
      },
    });
    expect(read.envEnabled).toBe(false);
    expect(read.bounds.trialCredits).toEqual({ min: 500, max: 20000 });
    expect(
      signUpSettingsSchema.safeParse({ enabled: true, trialDays: 14, cardRequiredAfterDays: 14 })
        .success,
    ).toBe(false);
    expect(
      signUpSettingsSchema.parse({
        enabled: true,
        trialDays: 1,
        cardRequiredAfterDays: 1,
        trialCredits: 1,
      }).bounds,
    ).toEqual({ trialDays: null, cardRequiredAfterDays: null, trialCredits: null });
  });

  it('★ the domain row: a public domain defaults to false only when unsaid', () => {
    expect(domainJoinSchema.parse({ domain: 'aviv.co', joinByDomain: true }).publicDomain).toBe(
      false,
    );
    expect(domainJoinSchema.safeParse({ joinByDomain: true }).success).toBe(false);
  });

  it('★ only "card_required" holds the organization for a card', () => {
    expect(cardRequired('card_required')).toBe(true);
    expect(cardRequired('trial_ended')).toBe(false);
    expect(cardRequired(undefined)).toBe(false);
  });
});
