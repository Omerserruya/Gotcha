import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_GOOGLE_MARKERS,
  markerOf,
  setupStateSchema,
  SIGN_IN_GOOGLE_MARKERS,
  signInConnectionsSchema,
  signInRecordSchema,
  termsAcceptBody,
  termsStateSchema,
} from './google-sign-in';

/**
 * ★★ Google sign-in's wire (Backend ff3a1b9f), as the web reads it: the card
 * is read whole, the callback's record never fails a sign-in, and a marker
 * in a URL is one of a fixed few.
 */

describe('★★ the connected-accounts read', () => {
  it('reads Backend’s connected answer', () => {
    const read = signInConnectionsSchema.parse({
      google: {
        available: true,
        connected: true,
        email: 'maya@avivco.il',
        connectedAt: '2026-11-22T10:00:00Z',
        canDisconnect: false,
        reason: 'no_other_sign_in',
      },
    });
    expect(read.google).toEqual({
      available: true,
      connected: true,
      email: 'maya@avivco.il',
      connectedAt: '2026-11-22T10:00:00Z',
      canDisconnect: false,
      reason: 'no_other_sign_in',
    });
  });

  it('reads the off answer (GOOGLE_OFF) - the card is then not drawn', () => {
    const read = signInConnectionsSchema.parse({
      google: {
        available: false,
        connected: false,
        email: null,
        connectedAt: null,
        canDisconnect: false,
        reason: null,
      },
    });
    expect(read.google.available).toBe(false);
  });

  it('⚠ the two facts the card cannot guess are required: no `connected`, no read', () => {
    expect(signInConnectionsSchema.safeParse({ google: { available: true } }).success).toBe(false);
    expect(signInConnectionsSchema.safeParse({}).success).toBe(false);
  });

  it('★ the optional ones default to nothing, never to a claim', () => {
    const read = signInConnectionsSchema.parse({ google: { available: true, connected: false } });
    expect(read.google).toMatchObject({
      email: null,
      connectedAt: null,
      canDisconnect: false,
      reason: null,
    });
  });
});

describe('★★ the sign-in record never fails the sign-in', () => {
  it('reads Backend’s answer', () => {
    expect(
      signInRecordSchema.parse({ method: 'google', google: 'connected', termsRequired: true }),
    ).toEqual({ method: 'google', google: 'connected', termsRequired: true });
  });

  it.each([{}, { google: 'yes', termsRequired: 'maybe', method: 7 }])(
    '★ an odd or empty body (%j) reads as no marker of any kind',
    (raw) => {
      expect(signInRecordSchema.parse(raw)).toEqual({
        method: 'unknown',
        google: null,
        termsRequired: false,
      });
    },
  );
});

describe('★★ the Terms', () => {
  it('reads the flag', () => {
    expect(termsStateSchema.parse({ termsRequired: true }).termsRequired).toBe(true);
    expect(termsStateSchema.safeParse({}).success).toBe(false);
  });

  it('★★ the accept body is the setup screen’s: both booleans true, the language, the words seen', () => {
    expect(termsAcceptBody('he', '  קראתי ואישרתי  ')).toEqual({
      terms: true,
      privacy: true,
      locale: 'he',
      capturedText: 'קראתי ואישרתי',
    });
    expect(termsAcceptBody('en-GB', 'x').locale).toBe('en');
    expect(termsAcceptBody('he-IL', 'x').locale).toBe('he');
  });

  it('⚠ the words are cut at the server’s 1000 characters, not refused', () => {
    expect(termsAcceptBody('en', 'a'.repeat(1200)).capturedText).toHaveLength(1000);
  });
});

describe('★ the setup link’s state', () => {
  it('reads the flag and the address; absent is no Google', () => {
    expect(setupStateSchema.parse({ state: 'valid', email: 'a@b.co', google: true })).toMatchObject(
      {
        google: true,
        email: 'a@b.co',
      },
    );
    expect(setupStateSchema.parse({ state: 'revoked', email: null })).toMatchObject({
      google: false,
      email: null,
    });
  });
});

describe('★★ a marker in a URL is one of a fixed few', () => {
  it.each([
    ['no-account', SIGN_IN_GOOGLE_MARKERS, 'no-account'],
    ['start', SIGN_IN_GOOGLE_MARKERS, 'start'],
    ['connected', SIGN_IN_GOOGLE_MARKERS, null],
    ['connected', ACCOUNT_GOOGLE_MARKERS, 'connected'],
    ['other_account', ACCOUNT_GOOGLE_MARKERS, 'other_account'],
    ['<script>', ACCOUNT_GOOGLE_MARKERS, null],
    [['connected'], ACCOUNT_GOOGLE_MARKERS, null],
    [undefined, ACCOUNT_GOOGLE_MARKERS, null],
  ] as const)('%j in its list reads as %j', (raw, known, want) => {
    expect(markerOf(raw, known)).toBe(want);
  });
});
