/*
 * @vitest-environment node
 *
 * Session sealing is server-side and runs on Node's WebCrypto. Under jsdom,
 * `TextEncoder` yields a Uint8Array from another realm and jose's own
 * `instanceof` check rejects it - a jsdom artifact, not a real failure.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetServerEnvCache } from '@/config/env.server';

import {
  MAX_COOKIE_BYTES,
  SessionTooLargeError,
  sealSession,
  unsealSession,
  type Session,
} from './session';

const COOKIE_NAME = 'gotcha_session';

/** Realistic shapes: Authentik issues JWTs, not opaque strings. */
const token = (bytes: number): string => 'a'.repeat(bytes);

const session = (overrides: Partial<Session> = {}): Session => ({
  sub: 'f7a1c2d3-0000-4a5b-8c9d-1e2f3a4b5c6d',
  sid: '11111111-2222-4333-8444-555555555555',
  at: token(900),
  rt: token(700),
  exp: 2_000_000_000,
  abs: 2_000_000_000,
  ...overrides,
});

beforeEach(() => {
  process.env.SESSION_SECRET = 'x'.repeat(48);
  process.env.SESSION_COOKIE_NAME = COOKIE_NAME;
  process.env.API_BASE_URL = 'http://localhost';
  process.env.APP_ORIGIN = 'http://localhost:3000';
  process.env.OIDC_ISSUER = 'https://auth.example/application/o/gotcha/';
  process.env.OIDC_CLIENT_ID = 'gotcha-app';
  resetServerEnvCache();
});

afterEach(() => {
  resetServerEnvCache();
});

describe('sealSession', () => {
  it('round-trips a session', async () => {
    const original = session({ tid: 'tenant-1' });
    expect(await unsealSession(await sealSession(original))).toEqual(original);
  });

  it('rejects a tampered cookie rather than trusting it', async () => {
    const sealed = await sealSession(session());
    expect(await unsealSession(`${sealed.slice(0, -2)}xy`)).toBeNull();
  });

  it('rejects a session past its absolute expiry', async () => {
    const expired = session({ abs: 1 });
    expect(await unsealSession(await sealSession(expired))).toBeNull();
  });

  /*
   * The regression this file exists for. Storing the OIDC id token pushed the
   * cookie past 4096 bytes; browsers discard such a cookie silently, so
   * sign-in "succeeded" and then looped back to sign-in forever. Nothing in
   * the app could observe it.
   */
  it('keeps a realistic session well inside the browser cookie limit', async () => {
    const sealed = await sealSession(session());
    expect(COOKIE_NAME.length + 1 + sealed.length).toBeLessThan(MAX_COOKIE_BYTES);
  });

  it('still fits when the provider issues unusually large tokens', async () => {
    const sealed = await sealSession(session({ at: token(1500), rt: token(1200) }));
    expect(COOKIE_NAME.length + 1 + sealed.length).toBeLessThan(MAX_COOKIE_BYTES);
  });

  it('throws rather than emitting a cookie the browser would discard', async () => {
    // An id token of this size is what the loop was made of.
    const oversized = session({ at: token(900), rt: token(700), sub: token(1800) });
    await expect(sealSession(oversized)).rejects.toBeInstanceOf(SessionTooLargeError);
  });
});
