import { describe, expect, it } from 'vitest';

import {
  businessAppOptionsSchema,
  candidateSchema,
  explainsCoexistence,
  inspectResponseSchema,
  isConnectable,
  needsPin,
} from './whatsapp-connect';

const candidate = (over: Record<string, unknown> = {}) =>
  candidateSchema.parse({ phoneNumberId: 'p1', scenario: 'NEW_NUMBER', ...over });

describe('★ the PIN is known before anything is submitted', () => {
  it('reads it off the candidate rather than discovering it on failure', () => {
    /*
     * `customerAction` is on the row, so the screen can say "you will need
     * your two-step PIN" before the click instead of after the register step
     * fails. That is the whole reason the field is useful.
     */
    expect(needsPin(candidate({ customerAction: 'TWO_STEP_PIN' }))).toBe(true);
  });

  it('does not claim a PIN for the other four actions', () => {
    for (const action of [
      'VERIFICATION_CODE',
      'BUSINESS_APP_CONFIRMATION',
      'BUSINESS_VERIFICATION',
      'DISPLAY_NAME_REVIEW',
    ] as const) {
      expect(needsPin(candidate({ customerAction: action }))).toBe(false);
    }
    expect(needsPin(candidate())).toBe(false);
  });
});

describe('★ two kinds of impossibility', () => {
  it('refuses to connect a BLOCKED row', () => {
    // "Not you, not now" — a blocker the customer can clear.
    const blocked = candidate({
      scenario: 'BLOCKED',
      blockers: ['This number belongs to another GOTCHA workspace.'],
    });
    expect(isConnectable(blocked)).toBe(false);
    expect(blocked.blockers).toHaveLength(1);
  });

  it('★ types full migration as never available, not unavailable here', () => {
    /*
     * "Not anyone, not ever." Meta publishes no API for moving a Business app
     * number to Cloud API; `available` is the literal `false` upstream. A
     * greyed-out control would read as "you did not qualify", and this
     * merchant did not fail a check.
     */
    const opts = businessAppOptionsSchema.parse({
      keepUsingBusinessApp: {
        title: 'Keep using the WhatsApp Business app',
        description: 'Both keep working.',
        throughputNote: 'Meta caps these at 20 messages per second.',
        limitations: ['Group chats stay on your phone.'],
      },
      fullMigration: {
        available: false,
        title: 'Move completely to GOTCHA',
        reason: 'Meta has no way to move a Business app number without deleting the account.',
      },
    });
    expect(opts.fullMigration.available).toBe(false);
    // The reason is the payload, which is what makes prose possible.
    expect(opts.fullMigration.reason).toMatch(/without deleting/i);
  });

  it('rejects a payload claiming migration IS available', () => {
    // The literal is the guard: if Meta ever ships the API, this fails loudly
    // rather than rendering a control nobody designed.
    expect(() =>
      businessAppOptionsSchema.parse({
        keepUsingBusinessApp: { title: 't', description: 'd' },
        fullMigration: { available: true, title: 't', reason: 'r' },
      }),
    ).toThrow();
  });
});

describe('every connectable row is offered and every blocked one is not', () => {
  it('connects the five non-blocked scenarios', () => {
    for (const scenario of [
      'NEW_NUMBER',
      'COEXISTENCE',
      'EXISTING_CLOUD_API',
      'RECONNECT',
      'MIGRATION',
    ] as const) {
      expect(isConnectable(candidate({ scenario }))).toBe(true);
    }
  });

  it('explains coexistence for a Business app number, however it was labelled', () => {
    expect(explainsCoexistence(candidate({ usesBusinessApp: true }))).toBe(true);
    expect(explainsCoexistence(candidate({ scenario: 'COEXISTENCE' }))).toBe(true);
    expect(explainsCoexistence(candidate())).toBe(false);
  });
});

describe('the session id is the only credential the browser holds', () => {
  it('carries a session id and no token', () => {
    /*
     * "The token must never reach the browser. It is a customer-scoped
     * credential that can read and modify their WhatsApp accounts."
     */
    const parsed = inspectResponseSchema.parse({
      sessionId: 's1',
      candidates: [{ phoneNumberId: 'p1', scenario: 'NEW_NUMBER' }],
      accessToken: 'leaked-if-this-survives',
    });
    expect(parsed.sessionId).toBe('s1');
    expect(parsed).not.toHaveProperty('accessToken');
  });
});
