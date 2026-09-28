import { describe, expect, it } from 'vitest';

import {
  AUTHENTICATION_FLOW,
  firstError,
  NON_FIELD,
  readChallenge,
  REMEMBER_ME,
  staySignedInBody,
  deviceChallengeSchema,
  devicesByRecency,
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
     * ★ THIS USED `ak-stage-authenticator-validate` AS ITS EXAMPLE, and that
     * stage has since been observed and is parsed — so the example had to change
     * or the test would be asserting that a known stage is unknown. A consent
     * stage is genuinely unseen here.
     *
     * Somebody's password has already been accepted by the time an unexpected
     * stage arrives, so improvising strands them mid-sign-in.
     */
    const step = readChallenge({ type: 'native', component: 'ak-stage-consent' });
    expect(step).toEqual({ kind: 'handOver', because: 'ak-stage-consent' });
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

describe('★★ the second factor — observed, parsed, and deliberately not rendered', () => {
  /** The real payload, 2026-09-28, from an enrolled account. */
  const validate = (over: Record<string, unknown> = {}) => ({
    flow_info: { title: 'Welcome back', cancel_url: '/flows/-/cancel/' },
    component: 'ak-stage-authenticator-validate',
    pending_user: 'akadmin',
    device_challenges: [
      { device_class: 'static', device_uid: '1', challenge: {}, last_used: null },
      {
        device_class: 'totp',
        device_uid: '1',
        challenge: {},
        last_used: '2026-08-07T06:58:58.258317Z',
      },
    ],
    configuration_stages: [],
    ...over,
  });

  it('★★ reads it as its own step, not as an unknown stage', () => {
    const step = readChallenge(validate());
    expect(step.kind).toBe('chooseFactor');
    if (step.kind !== 'chooseFactor') return;
    expect(step.challenge.device_challenges).toHaveLength(2);
    expect(step.challenge.pending_user).toBe('akadmin');
  });

  it('★★ keeps `static`, because that is recovery codes and it arrives as a PEER', () => {
    /*
     * The finding that makes this stage a design question rather than a text
     * box. `static` is not a link under a code field — it is an entry in the same
     * list as the authenticator app, so the stage is **a choice between
     * devices**. A parser that filtered to "the code one" would delete somebody's
     * only way in when their phone is lost, which is the entire point of recovery
     * codes.
     */
    const step = readChallenge(validate());
    if (step.kind !== 'chooseFactor') throw new Error('expected chooseFactor');
    expect(step.challenge.device_challenges.map((d) => d.device_class)).toEqual(['static', 'totp']);
  });

  it('★★ carries a device class nobody here has seen', () => {
    /*
     * Authentik also ships `webauthn`, `duo`, `sms` and `email`. Dropping an
     * unrecognised class would silently remove somebody's only second factor from
     * the list — and they would be told they have none.
     */
    const step = readChallenge(
      validate({
        device_challenges: [
          { device_class: 'webauthn', device_uid: '3', challenge: {}, last_used: null },
        ],
      }),
    );
    if (step.kind !== 'chooseFactor') throw new Error('expected chooseFactor');
    expect(step.challenge.device_challenges[0]!.device_class).toBe('webauthn');
  });

  it('★ notices when enrolment is offered, which is 00b’s missing half', () => {
    // Empty for an enrolled user. Populated is where enrolment would live, and
    // nobody has seen that yet.
    const step = readChallenge(validate({ configuration_stages: [{ component: 'x' }] }));
    if (step.kind !== 'chooseFactor') throw new Error('expected chooseFactor');
    expect(step.challenge.configuration_stages).toHaveLength(1);
  });
});

describe('★★ devicesByRecency — the familiar one first', () => {
  const device = (deviceClass: string, lastUsed: string | null) =>
    deviceChallengeSchema.parse({
      device_class: deviceClass,
      device_uid: '1',
      last_used: lastUsed,
    });

  it('★★ puts the most recently used first and the never-used last', () => {
    /*
     * "Never make somebody choose a method they cannot remember picking", applied
     * to a list whose order they did not choose. `last_used` is null on a device
     * nobody has touched — recovery codes, usually — and that is exactly the one
     * that should not be at the top.
     */
    const ordered = devicesByRecency([
      device('static', null),
      device('totp', '2026-08-07T06:58:58Z'),
      device('webauthn', '2026-09-01T10:00:00Z'),
    ]);
    expect(ordered.map((d) => d.device_class)).toEqual(['webauthn', 'totp', 'static']);
  });

  it('★★ is stable, so the list does not reshuffle between renders', () => {
    /*
     * Two devices with the same `last_used` — or two with none — keep the order
     * the server sent. A picker that reorders itself on re-render is one where
     * somebody clicks the wrong device, and on this screen the wrong device is a
     * recovery code they only have ten of.
     */
    const same = '2026-08-07T06:58:58Z';
    const ordered = devicesByRecency([device('a', same), device('b', same), device('c', null)]);
    expect(ordered.map((d) => d.device_class)).toEqual(['a', 'b', 'c']);

    const none = devicesByRecency([device('x', null), device('y', null)]);
    expect(none.map((d) => d.device_class)).toEqual(['x', 'y']);
  });

  it('★ treats an unparseable timestamp as never-used rather than as very old', () => {
    /*
     * `Date.parse` gives NaN, and NaN sorts unpredictably. Treating it as unknown
     * puts it with the never-used, which is the honest place for a device we
     * cannot date.
     */
    const ordered = devicesByRecency([
      device('bad', 'not-a-date'),
      device('good', '2026-01-01T00:00:00Z'),
    ]);
    expect(ordered.map((d) => d.device_class)).toEqual(['good', 'bad']);
  });

  it('★ does not mutate what it was given — a guard on a refactor, not on a line', () => {
    /*
     * ★ STATED BECAUSE A MUTATION SURVIVED IT. No single-line edit to the current
     * implementation can make this fail: `.map()` already returns a new array, so
     * the `[...devices]` spread is belt-and-braces and the `.sort()` never touches
     * the caller's array.
     *
     * It is kept because the natural "simplification" — dropping the intermediate
     * map and sorting in place — DOES make it fail, and that refactor is the
     * likely one. A test that only a refactor can break is worth having as long
     * as nobody mistakes its green for evidence about the line beside it.
     */
    const devices = [device('a', null), device('b', '2026-01-01T00:00:00Z')];
    devicesByRecency(devices);
    expect(devices.map((d) => d.device_class)).toEqual(['a', 'b']);
  });
});
