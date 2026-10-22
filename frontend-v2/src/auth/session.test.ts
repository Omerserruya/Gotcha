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
    /*
     * ★★ THE TAMPER IS PROVEN TO TAMPER, BECAUSE TWICE IT DID NOT.
     *
     * First version: `${sealed.slice(0, -2)}xy` - a no-op whenever the seal
     * already ended in "xy". About one in four thousand. It failed once in a
     * full-suite run and passed alone, the signature of a flake.
     *
     * Second version, my fix: flip the final character A↔B. Also a no-op,
     * and more often. This is JWE compact -
     * `header.key.iv.ciphertext.tag` - and a 16-byte GCM tag is 22 base64url
     * characters carrying 128 bits. 21 × 6 = 126, so the FINAL character
     * contributes two significant bits and four of padding. 'A' and 'B'
     * differ only in the lowest bit, which is padding, so the two strings
     * decode to an identical tag.
     *
     * ★ Both versions assumed the mutation mutated. The lesson is not "pick
     * a better character" - it is that a test which tampers must PROVE the
     * tamper, the same way a mutation run proves a guard can fail.
     *
     * So: change the first character of the CIPHERTEXT segment, where every
     * bit is significant, and assert the decoded bytes actually differ
     * before asserting the seal rejects them.
     */
    const sealed = await sealSession(session());
    const parts = sealed.split('.');
    expect(parts, 'JWE compact serialization has five segments').toHaveLength(5);

    const ciphertext = parts[3]!;
    const head = ciphertext[0]!;
    const swapped = head === 'A' ? 'Z' : 'A';
    const tamperedCiphertext = `${swapped}${ciphertext.slice(1)}`;

    // The tamper is real at the BYTE level, not merely at the string level.
    expect(
      Buffer.from(tamperedCiphertext, 'base64url').equals(Buffer.from(ciphertext, 'base64url')),
      'the tamper decoded to identical bytes, so this test would assert nothing',
    ).toBe(false);

    parts[3] = tamperedCiphertext;
    expect(await unsealSession(parts.join('.'))).toBeNull();
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
