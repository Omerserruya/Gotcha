import { describe, expect, it } from 'vitest';

import {
  AUTHENTICATION_FLOW,
  firstError,
  NON_FIELD,
  readChallenge,
  REMEMBER_ME,
  staySignedInBody,
} from './auth-flow';

/**
 * Screen 00a's reading of Authentik's flow executor.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE SUBJECT OF THESE TESTS IS THE FALLBACK, NOT THE HAPPY PATH
 * ════════════════════════════════════════════════════════════════════════════
 * A flow is Authentik configuration, not a deploy of ours. An administrator can
 * add a stage this afternoon, and our panel would then meet a component it has
 * never heard of **mid-sign-in, with somebody's password already accepted.**
 *
 * The identity provider's own page can still finish any flow. So an unknown
 * stage is not an error, it is a handover — and most of what is asserted here is
 * that we hand over rather than improvise.
 *
 * The two known stages were measured against the real tenant on 2026-09-28.
 */

const identification = (over: Record<string, unknown> = {}) => ({
  type: 'native',
  component: 'ak-stage-identification',
  flow_info: { title: 'Welcome back', cancel_url: '' },
  user_fields: ['email', 'username'],
  password_fields: true,
  recovery_url: '/if/flow/gotcha-recovery-self/',
  primary_action: 'Log in',
  response_errors: {},
  ...over,
});

describe('★★ the two stages this tenant actually has', () => {
  it('reads identification, and keeps the recovery url from the challenge', () => {
    /*
     * `recovery_url` is a flow slug an administrator can change. Hardcoding
     * `/if/flow/gotcha-recovery-self/` sends somebody who has forgotten their
     * password to a 404 the day it is renamed — and that is the one person on
     * this screen who cannot get in by trying harder.
     */
    const step = readChallenge(identification());
    expect(step.kind).toBe('identify');
    if (step.kind !== 'identify') return;
    expect(step.challenge.recovery_url).toBe('/if/flow/gotcha-recovery-self/');
    expect(step.challenge.password_fields).toBe(true);
  });

  it('reads "stay signed in" as a stage, which is why it can live in our panel', () => {
    const step = readChallenge({
      type: 'native',
      component: 'ak-stage-user-login',
      pending_user: 'maya@avivco.il',
    });
    expect(step.kind).toBe('staySignedIn');
  });

  it('★★ reads completion, and does not offer the IdP’s path as a destination', () => {
    /*
     * Measured: a completed sign-in returns `{ to: "/" }`, and that `/` is
     * **Authentik's root, not ours**. Following it lands somebody who has just
     * signed in successfully on a stranger's home page.
     *
     * The field is renamed on the way out so that using it reads as a deliberate
     * act. The panel's next move is always our own `/api/auth/login`.
     */
    const step = readChallenge({ type: 'redirect', component: 'xak-flow-redirect', to: '/' });
    expect(step).toEqual({ kind: 'done', idpPath: '/' });
    expect(step).not.toHaveProperty('to');
  });

  it('★★ knows the body that completes "stay signed in", which the challenge never states', () => {
    /*
     * `ak-stage-user-login` returns four keys and requires a field none of them
     * mention. Posting `{}` answers `remember_me: ["This field is required."]`.
     * A renderer written from the challenge shape alone would have sent nothing
     * and been told at runtime, by a user, that a field it had never heard of
     * was missing.
     */
    expect(staySignedInBody(true)).toEqual({ remember_me: true });
    expect(staySignedInBody(false)).toEqual({ remember_me: false });
    expect(REMEMBER_ME).toBe('remember_me');
  });

  it('★ names the flow, and not the alias that resolves to it', () => {
    /*
     * `/flows/-/default/authentication/` is an alias the admin UI can repoint
     * without anyone touching our code, which would leave the panel driving a
     * different flow than the one the application authorises against.
     */
    expect(AUTHENTICATION_FLOW).toBe('default-authentication-flow');
    expect(AUTHENTICATION_FLOW).not.toContain('/');
  });
});

describe('★★ anything else is a handover, not an improvisation', () => {
  it('★★ hands over on a stage we have never heard of', () => {
    /*
     * The realistic case: an admin enables two-step. A panel that renders
     * nothing, or renders its identification form again, strands somebody whose
     * password has already been accepted.
     */
    const step = readChallenge({ type: 'native', component: 'ak-stage-authenticator-validate' });
    expect(step).toEqual({ kind: 'handOver', because: 'ak-stage-authenticator-validate' });
  });

  it('★★ hands over when identification does NOT want a password', () => {
    /*
     * `password_fields: true` is what makes 00a a single submit. If the flow is
     * reconfigured to ask separately, our one-action screen is no longer what the
     * flow does — and rendering a password box the stage will reject is worse
     * than handing over, because it fails after the typing rather than before.
     */
    const step = readChallenge(identification({ password_fields: false }));
    expect(step).toEqual({ kind: 'handOver', because: 'identification-without-password' });
  });

  it('★★ never throws on a body it cannot read at all', () => {
    /*
     * A parse failure here happens on a screen where somebody has just typed a
     * password. An exception would surface as a crash mid-sign-in; a handover
     * surfaces as the page that has always worked.
     */
    for (const raw of [null, undefined, 'nope', 42, {}, { component: 123 }, []]) {
      expect(() => readChallenge(raw)).not.toThrow();
      expect(readChallenge(raw).kind).toBe('handOver');
    }
  });

  it('★ names the component in the handover, so a log says which one', () => {
    expect(readChallenge({ component: 'ak-stage-consent' })).toEqual({
      kind: 'handOver',
      because: 'ak-stage-consent',
    });
    expect(readChallenge({})).toEqual({ kind: 'handOver', because: 'unreadable' });
  });

  it('★★ keeps fields we never named, because this API is not ours to bound', () => {
    /*
     * Every other contract in the repo is strict, and this one is loose on
     * purpose. A strict object would drop `flow_designation` silently, and from
     * inside this codebase that reads as Authentik not sending it — the exact
     * mistake that hid three fields on contracts we DO own this week.
     */
    const step = readChallenge(identification({ flow_designation: 'authentication' }));
    if (step.kind !== 'identify') throw new Error('expected identify');
    expect((step.challenge as Record<string, unknown>).flow_designation).toBe('authentication');
  });
});

describe('★★ what a failed sign-in is allowed to say', () => {
  it('★★ prefers the non-field message, which is the one that does not leak', () => {
    /*
     * Authentik deliberately does not say whether the email or the password was
     * wrong. Telling an attacker which half they got right turns an address list
     * into an account list, so we keep that property rather than attributing a
     * failure to a field ourselves.
     */
    /*
     * ★ THE FIELD ERROR IS LISTED FIRST ON PURPOSE. The first version of this put
     * `non_field_errors` first, and deleting the preference entirely still
     * passed — `Object.values` iterates in insertion order, so the loop found
     * the same string by accident. A fixture where both rules give the same
     * answer cannot tell them apart, which is the third time this week.
     */
    expect(
      firstError({
        password: [{ string: 'This field is required.', code: 'required' }],
        [NON_FIELD]: [{ string: 'Failed to authenticate.', code: 'invalid' }],
      }),
    ).toBe('Failed to authenticate.');
  });

  it('falls back to a field message when that is all there is', () => {
    expect(firstError({ uid_field: [{ string: 'Enter an email.', code: 'required' }] })).toBe(
      'Enter an email.',
    );
  });

  it('★★ says nothing when the stage reported nothing', () => {
    /*
     * Three states. "The stage refused and said why", "the stage refused and said
     * nothing", and "nothing was submitted" are different, and inventing a
     * sentence for the second is how a screen blames a password that was right.
     */
    expect(firstError(undefined)).toBeNull();
    expect(firstError({})).toBeNull();
    expect(firstError({ [NON_FIELD]: [] })).toBeNull();
    expect(firstError({ [NON_FIELD]: [{ string: '   ', code: 'invalid' }] })).toBeNull();
  });
});
