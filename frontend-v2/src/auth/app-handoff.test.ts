// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/config/env.server', () => ({
  serverEnv: () => ({ SESSION_SECRET: 'x'.repeat(32) }),
}));

const {
  apexOf,
  isChallenge,
  redeemHandoffCode,
  s256,
  sealHandoffCode,
  sealHandoffStart,
  unsealHandoffStart,
  APP_HANDOFF_CODE_SECONDS,
} = await import('./app-handoff');

const VERIFIER = 'v'.repeat(43);
const SESSION = { s: 'sealed-session', i: 'sealed-id', t: true };
const NOW = 1_800_000_000;

describe('★★ the app handoff code (2026-11-24)', () => {
  it('★ S256 as RFC 7636 computes it (its own test vector)', async () => {
    expect(await s256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('★★ the right verifier, in time: the session the callback sealed', async () => {
    const code = await sealHandoffCode(await s256(VERIFIER), SESSION, NOW);
    expect(await redeemHandoffCode(code, VERIFIER, NOW + 10)).toEqual(SESSION);
  });

  it('⚠⚠ another verifier: nothing', async () => {
    const code = await sealHandoffCode(await s256(VERIFIER), SESSION, NOW);
    expect(await redeemHandoffCode(code, 'w'.repeat(43), NOW)).toBeNull();
  });

  it('⚠⚠ past its 60 seconds: nothing', async () => {
    const code = await sealHandoffCode(await s256(VERIFIER), SESSION, NOW);
    expect(await redeemHandoffCode(code, VERIFIER, NOW + APP_HANDOFF_CODE_SECONDS)).toEqual(
      SESSION,
    );
    expect(await redeemHandoffCode(code, VERIFIER, NOW + APP_HANDOFF_CODE_SECONDS + 1)).toBeNull();
  });

  it('⚠⚠ tampered, or not ours: nothing', async () => {
    const code = await sealHandoffCode(await s256(VERIFIER), SESSION, NOW);
    expect(await redeemHandoffCode(`${code.slice(0, -4)}AAAA`, VERIFIER, NOW)).toBeNull();
    expect(await redeemHandoffCode('not-a-jwe', VERIFIER, NOW)).toBeNull();
  });

  it('⚠⚠ the start cookie is not a code, and a code is not a start cookie', async () => {
    const challenge = await s256(VERIFIER);
    const start = await sealHandoffStart(challenge);
    expect(await redeemHandoffCode(start, VERIFIER, NOW)).toBeNull();
    expect(await unsealHandoffStart(start)).toBe(challenge);
    expect(await unsealHandoffStart(await sealHandoffCode(challenge, SESSION, NOW))).toBeNull();
  });

  it('⚠ a verifier that is not RFC 7636 shaped is refused before anything', async () => {
    const code = await sealHandoffCode(await s256('short'), SESSION, NOW);
    expect(await redeemHandoffCode(code, 'short', NOW)).toBeNull();
  });

  it.each([
    ['E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', true],
    ['too-short', false],
    ['E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw+cM', false],
    [null, false],
  ])('challenge %s -> %s', (value, ok) => {
    expect(isChallenge(value)).toBe(ok);
  });

  it.each([
    ['app.gotcha.co.il', 'gotcha.co.il'],
    ['dev.gotcha.co.il', 'gotcha.co.il'],
    ['localhost', null],
    ['example.com', null],
  ])('apex of %s -> %s', (host, apex) => {
    expect(apexOf(host)).toBe(apex);
  });
});
