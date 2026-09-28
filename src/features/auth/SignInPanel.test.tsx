import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FlowStep } from '@/api/contracts/auth-flow';
import messages from '@/i18n/messages/en/auth.json';

import { SignInPanel } from './SignInPanel';

/**
 * Screen 00a, and the password that must not go anywhere else.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠⚠ WHAT THESE TESTS ARE ACTUALLY FOR
 * ════════════════════════════════════════════════════════════════════════════
 * This is the first screen in the product that handles a credential. The
 * architecture's whole claim is that the password goes **browser → nginx →
 * Authentik** and never enters our Node process, which holds only while the one
 * module that touches the network here is the executor client.
 *
 * So the first test asserts the negative: nothing else is called, and `fetch`
 * itself is never reached from this component. It is the assertion that would
 * catch somebody "simplifying" this into a server action.
 */

const startFlow = vi.hoisted(() => vi.fn<() => Promise<FlowStep | null>>());
const submitStage = vi.hoisted(() => vi.fn());
vi.mock('@/api/client/flow-executor', () => ({ startFlow, submitStage }));

const identify = (over: Record<string, unknown> = {}): FlowStep => ({
  kind: 'identify',
  challenge: {
    component: 'ak-stage-identification',
    user_fields: ['email', 'username'],
    password_fields: true,
    recovery_url: '/if/flow/gotcha-recovery-self/',
    primary_action: 'Log in',
    response_errors: {},
    ...over,
  } as never,
});

const staySignedIn = (errors: Record<string, unknown> = {}): FlowStep => ({
  kind: 'staySignedIn',
  challenge: {
    component: 'ak-stage-user-login',
    pending_user: 'maya@avivco.il',
    response_errors: errors,
  } as never,
});

const assign = vi.hoisted(() => vi.fn());
const HANDOVER = '/v2/api/auth/login?returnTo=%2Finbox';

const show = (returnTo?: string) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ auth: messages }}>
      <SignInPanel handOverHref={HANDOVER} returnTo={returnTo} />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('a test must never fetch here'))),
  );
  Object.defineProperty(window, 'location', {
    value: { assign, href: 'https://dev.gotcha.co.il/v2/en/sign-in' },
    writable: true,
    configurable: true,
  });
  assign.mockReset();
  startFlow.mockReset().mockResolvedValue(identify());
  submitStage.mockReset().mockResolvedValue({ ok: true, step: staySignedIn() });
});

describe('⚠⚠ the password goes to the executor and nowhere else', () => {
  it('⚠⚠ submits it through the executor client, and never touches fetch itself', async () => {
    /*
     * The assertion the architecture rests on. `fetch` is stubbed to reject, so
     * a component that called it directly — or through our own `browserApi`,
     * which would put the credential on the same path as every request carrying
     * our session cookie — fails loudly rather than quietly working.
     */
    const user = userEvent.setup();
    show();
    await user.type(await screen.findByTestId('email'), 'maya@avivco.il');
    await user.type(screen.getByTestId('password'), 'correct horse');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() =>
      expect(submitStage).toHaveBeenCalledWith({
        uid_field: 'maya@avivco.il',
        password: 'correct horse',
      }),
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('⚠ the password input is a password field with the right autocomplete', async () => {
    // A `type="text"` here shows the credential to the room and puts it in the
    // browser's ordinary autofill history.
    show();
    const field = await screen.findByTestId('password');
    expect(field).toHaveAttribute('type', 'password');
    expect(field).toHaveAttribute('autocomplete', 'current-password');
  });
});

describe('★★ everything it cannot finish, it hands back', () => {
  it('★★ hands over when the flow will not start', async () => {
    /*
     * The panel has nothing to render without a stage. Handing over reaches the
     * identity provider's own page, which has always worked — this screen is an
     * optimisation over that path, not a replacement for it.
     */
    startFlow.mockResolvedValue(null);
    show();
    await waitFor(() => expect(assign).toHaveBeenCalledWith(HANDOVER));
  });

  it('★★ hands over on a stage it has never heard of', async () => {
    /*
     * ★ NOT A HYPOTHETICAL. `ak-stage-authenticator-validate` is what a colleague
     * who has already enrolled a device would meet here — the flow reports
     * `device_challenges: []` only for users with none, and nobody has been able
     * to read the stage bindings to say whether the stage exists. So this is the
     * ordinary path for an MFA user, not a guard against a future admin change.
     *
     * ⚠ AND ONE THING NOBODY HAS OBSERVED: the handover happens AFTER their
     * password was accepted. Whether the identity provider's page resumes the
     * in-progress flow — its state is a cookie — or asks for the password again
     * is unverified, and it is the difference between a seam and a retype.
     * Testable the moment somebody has an enrolled account.
    submitStage.mockResolvedValue({
      ok: true,
      step: { kind: 'handOver', because: 'ak-stage-authenticator-validate' },
    });
    const user = userEvent.setup();
    show();
    await user.type(await screen.findByTestId('email'), 'a@b.c');
    await user.type(screen.getByTestId('password'), 'x');
    await user.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(HANDOVER));
  });

  it('★★ on success it goes to OUR login route, never the IdP’s own path', async () => {
    /*
     * A completed flow answers `{ to: "/" }`, and that `/` is Authentik's root.
     * Following it lands somebody who has just signed in successfully on a
     * stranger's home page. The next move is always `/api/auth/login`, which
     * runs the OIDC exchange that gives us OUR session.
     */
    submitStage.mockResolvedValue({ ok: true, step: { kind: 'done', idpPath: '/' } });
    const user = userEvent.setup();
    show();
    await user.type(await screen.findByTestId('email'), 'a@b.c');
    await user.type(screen.getByTestId('password'), 'x');
    await user.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(HANDOVER));
    expect(assign).not.toHaveBeenCalledWith('/');
  });
});

describe('★★ what a refusal is allowed to say', () => {
  it('★★ shows the stage’s own sentence, not one of ours', async () => {
    /*
     * Authentik deliberately does not say whether the email or the password was
     * wrong. Writing a more specific message would undo that on our side, and
     * telling an attacker which half they got right turns an address list into an
     * account list.
     */
    submitStage.mockResolvedValue({
      ok: true,
      step: identify({
        response_errors: {
          non_field_errors: [{ string: 'Failed to authenticate.', code: 'invalid' }],
        },
      }),
    });
    const user = userEvent.setup();
    show();
    await user.type(await screen.findByTestId('email'), 'a@b.c');
    await user.type(screen.getByTestId('password'), 'wrong');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    const problem = await screen.findByTestId('sign-in-problem');
    expect(problem).toHaveTextContent('Failed to authenticate.');
    expect(assign).not.toHaveBeenCalled();
  });

  it('★★ offers recovery after a failure, and never an attempt count or a code path', async () => {
    /*
     * 00a specifies "after three attempts it offers the code path instead of
     * locking the account". **Nobody has been able to show that either exists.**
     * The flow reports `device_challenges: []` for an unenrolled user, which does
     * not distinguish "no authenticator stage" from "this user has not enrolled";
     * the endpoints that would settle it answer 403; and the lockout policy is
     * equally unreadable. Both sentences would be promises made on an unread
     * policy, to the one person on this screen who cannot get in by trying
     * harder.
     */
    submitStage.mockResolvedValue({
      ok: true,
      step: identify({
        response_errors: { non_field_errors: [{ string: 'No.', code: 'invalid' }] },
      }),
    });
    const user = userEvent.setup();
    show();
    await user.type(await screen.findByTestId('email'), 'a@b.c');
    await user.type(screen.getByTestId('password'), 'wrong');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    const problem = await screen.findByTestId('sign-in-problem');
    expect(screen.getByTestId('recover-after-fail')).toHaveAttribute(
      'href',
      '/if/flow/gotcha-recovery-self/',
    );
    expect(problem.textContent).not.toMatch(/\battempt|\btries|\block|whatsapp|sms|code/i);
  });

  it('★★ a transport failure keeps what was typed and does not blame the password', async () => {
    /*
     * The executor answers 200 with `response_errors` when it REFUSES, so a
     * transport failure means the proxy or the network. Rendering it as a wrong
     * password sends somebody to reset a password that was right — and clearing
     * the form would throw away a submit a second press often fixes.
     */
    submitStage.mockResolvedValue({ ok: false });
    const user = userEvent.setup();
    show();
    await user.type(await screen.findByTestId('email'), 'maya@avivco.il');
    await user.type(screen.getByTestId('password'), 'correct horse');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    const problem = await screen.findByTestId('sign-in-problem');
    expect(problem).toHaveTextContent(/couldn't reach sign-in/i);
    expect(problem.textContent).not.toMatch(/password|wrong|incorrect/i);
    expect(screen.getByTestId('email')).toHaveValue('maya@avivco.il');
    expect(screen.getByTestId('password')).toHaveValue('correct horse');
    expect(assign).not.toHaveBeenCalled();
  });
});

describe('★★ "keep me signed in" is a real answer to a required field', () => {
  it('★★ sends remember_me, which nothing in the challenge advertises', async () => {
    /*
     * `ak-stage-user-login` returns four keys and requires a field none of them
     * mention; posting `{}` answers "This field is required." So the checkbox is
     * not decorative — the flow cannot complete without the person's answer.
     */
    submitStage.mockResolvedValueOnce({ ok: true, step: staySignedIn() });
    const user = userEvent.setup();
    show();
    await user.type(await screen.findByTestId('email'), 'a@b.c');
    await user.type(screen.getByTestId('password'), 'x');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    const box = await screen.findByTestId('remember-me');
    expect(box).toBeChecked();
    await user.click(box);
    submitStage.mockResolvedValue({ ok: true, step: { kind: 'done', idpPath: '/' } });
    await user.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => expect(submitStage).toHaveBeenLastCalledWith({ remember_me: false }));
  });

  it('★★ does not promise a number of days that nothing here enforces', async () => {
    /*
     * The design's label says "for 30 days". Whether `false` shortens the session
     * and what the configured length is are Authentik settings nobody has read —
     * so the sentence would be a promise about session length made by a screen
     * that cannot keep it. Same rule as the absent lockout count.
     */
    submitStage.mockResolvedValueOnce({ ok: true, step: staySignedIn() });
    const user = userEvent.setup();
    show();
    await user.type(await screen.findByTestId('email'), 'a@b.c');
    await user.type(screen.getByTestId('password'), 'x');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    const label = (await screen.findByTestId('remember-me')).closest('label');
    expect(label).toHaveTextContent(/keep me signed in on this device/i);
    expect(label?.textContent).not.toMatch(/\d+\s*day|30/i);
  });
});

describe('⚠⚠ the two controls the mock draws and the prose does not mention', () => {
  /*
   * ════════════════════════════════════════════════════════════════════════════
   * BOTH WERE REFUSED AS "ADDITIONS" BEFORE ANYONE READ THE MOCK
   * ════════════════════════════════════════════════════════════════════════════
   * `Directions.dc.html`, screen 00a, in the field markup:
   *
   *     email     <span color:#4F7A2E><i data-lucide="check"  width=15 stroke-width=2.4>
   *     password  <span color:#A8A39A><i data-lucide="eye"    width=15 stroke-width=2>
   *
   * Omer reported them missing; two of us told him they were requests. The
   * prose says what the screen is for, the mock says what it is.
   */
  it('★★ shows the green check once the address is well-formed', async () => {
    show();
    const email = await screen.findByTestId('email');
    expect(screen.queryByTestId('email-valid')).toBeNull();

    await userEvent.type(email, 'maya@avivco.il');
    expect(screen.getByTestId('email-valid')).toBeInTheDocument();
  });

  it('⚠⚠ and shows nothing at all while it is still being typed', async () => {
    /*
     * Presence only, never absence. The design draws the affirmative state and
     * nothing else — a field that turns red mid-word is the reason people
     * abandon forms, and `not-an-email` is what every address looks like
     * before it is finished.
     */
    show();
    const email = await screen.findByTestId('email');
    await userEvent.type(email, 'not-an-email');
    expect(screen.queryByTestId('email-valid')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('★★ the reveal turns the password into text and back', async () => {
    show();
    const password = await screen.findByTestId('password');
    expect(password).toHaveAttribute('type', 'password');

    await userEvent.click(screen.getByTestId('reveal-password'));
    expect(password).toHaveAttribute('type', 'text');

    await userEvent.click(screen.getByTestId('reveal-password'));
    expect(password).toHaveAttribute('type', 'password');
  });

  it('⚠⚠ the reveal is a button, so it can never submit the form under it', async () => {
    /*
     * A `<button>` with no `type` inside a form submits it. On this form that
     * would post the credentials on a click meant to look at them.
     */
    show();
    expect(await screen.findByTestId('reveal-password')).toHaveAttribute('type', 'button');
  });

  it('★ and it says which state it is in, for somebody who cannot see the icon', async () => {
    show();
    const reveal = await screen.findByTestId('reveal-password');
    expect(reveal).toHaveAttribute('aria-pressed', 'false');
    expect(reveal).toHaveAccessibleName(/show password/i);

    await userEvent.click(reveal);
    expect(reveal).toHaveAttribute('aria-pressed', 'true');
    expect(reveal).toHaveAccessibleName(/hide password/i);
  });
});

describe('★★ one way in', () => {
  it('★★ offers no second method and no social sign-in', async () => {
    /*
     * The design: "One way in: work email and password. No social sign-in and no
     * second button to weigh up — nobody has to remember which method they picked
     * a year ago."
     *
     * ⚠⚠ THIS COUNTED BUTTONS AND HAD TO BE RE-AIMED. `getAllByRole('button')`
     *    was 1, and it broke the day the design's own password reveal arrived —
     *    **a correct screen failing a green test.** The rule is "no second
     *    sign-in METHOD"; the count was a proxy that held only while the form
     *    had exactly one control.
     *
     * ★ So: exactly one SUBMIT, and nothing offering another way in. A reveal,
     *   or anything else that does not submit, is not a method and must not
     *   redden this.
     */
    show();
    await screen.findByTestId('sign-in-form');

    const submits = screen
      .getAllByRole('button')
      .filter((control) => control.getAttribute('type') !== 'button');
    expect(submits).toHaveLength(1);
    expect(screen.queryByText(/google|microsoft|sso|single sign/i)).toBeNull();
  });

  it('★★ takes the recovery link from the challenge rather than hardcoding it', async () => {
    startFlow.mockResolvedValue(identify({ recovery_url: '/if/flow/renamed-recovery/' }));
    show();
    expect(await screen.findByTestId('forgot')).toHaveAttribute(
      'href',
      '/if/flow/renamed-recovery/',
    );
  });

  it('⚠⚠ refuses a recovery link that would execute instead of navigate', async () => {
    /*
     * ════════════════════════════════════════════════════════════════════════
     * A THIRD PARTY'S STRING, ON THE ONE PAGE WITH A PASSWORD FIELD
     * ════════════════════════════════════════════════════════════════════════
     * `recovery_url` is `z.string().nullable()` in a LOOSE contract — the shape
     * is Authentik's and by design we do not bound it. It rendered straight
     * into an `href`, where `javascript:` executes in the origin holding the
     * password. The narrowed CSP on this route does not stop it: a navigation
     * is not a script source.
     *
     * Not a claim that Authentik would send one — the contract permits any
     * string and this is the most sensitive sink in the app.
     */
    for (const hostile of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>']) {
      startFlow.mockResolvedValue(identify({ recovery_url: hostile }));
      const view = show();
      await screen.findByTestId('sign-in-form');
      expect(screen.queryByTestId('forgot'), hostile).toBeNull();
      view.unmount();
    }
  });

  it('★★ and still accepts an absolute one, which is what the origin move makes it', async () => {
    /*
     * Today the provider sends a path. Once sign-in is served from its own
     * origin this becomes an absolute URL, and a guard that only accepted
     * paths would silently remove the link for the one person on this screen
     * who cannot get in by trying harder.
     */
    startFlow.mockResolvedValue(
      identify({ recovery_url: 'https://auth.gotcha.co.il/if/flow/recovery/' }),
    );
    show();
    expect(await screen.findByTestId('forgot')).toHaveAttribute(
      'href',
      'https://auth.gotcha.co.il/if/flow/recovery/',
    );
  });

  it('★ offers no recovery link when the flow has no recovery configured', async () => {
    // A link to nothing is worse than no link on the one screen where the person
    // reading it already cannot get in.
    startFlow.mockResolvedValue(identify({ recovery_url: null }));
    show();
    await screen.findByTestId('sign-in-form');
    expect(screen.queryByTestId('forgot')).toBeNull();
  });

  it('★ says they will come back where they were, without naming a customer', async () => {
    /*
     * The design says "You were reading Dana Cohen's conversation." A customer's
     * name on a page nobody has authenticated to is a disclosure to whoever opens
     * the laptop; the `returnTo` round trip delivers the benefit without it.
     */
    show('/inbox?c=abc');
    expect(await screen.findByText(/straight back to where you were/i)).toBeInTheDocument();
  });
});

describe('⚠⚠ telling the layout which screen is on', () => {
  /*
   * ════════════════════════════════════════════════════════════════════════
   * THE LINK NOTHING WAS TESTING, FOUND BY A SURVIVING MUTATION
   * ════════════════════════════════════════════════════════════════════════
   * `SignInScreen` swaps the editorial, the status line and the footnote on
   * this signal — and its own tests use a STUB panel, while these tests never
   * passed `onScreen`. So replacing the whole mapping with a constant
   * `'signIn'` broke nothing anywhere: 71 tests green with the feature
   * destroyed.
   *
   * ★ Two halves, each thoroughly tested, and the join between them tested by
   *   neither. Guards assert hops; this is the hop.
   */
  it('⚠⚠ reports the second factor when the flow reaches it', async () => {
    const onScreen = vi.fn();
    startFlow.mockResolvedValue({
      kind: 'chooseFactor',
      challenge: {
        component: 'ak-stage-authenticator-validate',
        pending_user: 'akadmin',
        device_challenges: [
          { device_class: 'totp', device_uid: '1', challenge: {}, last_used: null },
        ],
        configuration_stages: [],
        response_errors: {},
      } as never,
    });

    render(
      <NextIntlClientProvider locale="en" messages={{ auth: messages }}>
        <SignInPanel handOverHref={HANDOVER} onScreen={onScreen} />
      </NextIntlClientProvider>,
    );

    await screen.findByTestId('second-factor');
    expect(onScreen).toHaveBeenCalledWith('secondFactor');
  });

  it('★★ and reports sign-in on the identification stage', async () => {
    /*
     * Both directions. A mapping that answered `secondFactor` for everything
     * would satisfy the assertion above and put 00b's editorial behind the
     * password field.
     */
    const onScreen = vi.fn();
    startFlow.mockResolvedValue(identify());

    render(
      <NextIntlClientProvider locale="en" messages={{ auth: messages }}>
        <SignInPanel handOverHref={HANDOVER} onScreen={onScreen} />
      </NextIntlClientProvider>,
    );

    await screen.findByTestId('sign-in-form');
    expect(onScreen).toHaveBeenCalledWith('signIn');
    expect(onScreen).not.toHaveBeenCalledWith('secondFactor');
  });

  it('★ and works without one, because the panel is complete on its own', async () => {
    // `onScreen` is optional: the panel's own tests render it without one and
    // must keep doing so.
    startFlow.mockResolvedValue(identify());
    show();
    expect(await screen.findByTestId('sign-in-form')).toBeInTheDocument();
  });
});
