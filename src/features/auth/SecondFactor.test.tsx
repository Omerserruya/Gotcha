import { readFileSync } from 'node:fs';

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  authenticatorValidateChallengeSchema,
  type AuthenticatorValidateChallenge,
} from '@/api/contracts/auth-flow';
import messages from '@/i18n/messages/en/auth.json';
import hebrewMessages from '@/i18n/messages/he/auth.json';

import { SecondFactor } from './SecondFactor';

/**
 * Screen 00b's first half.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE FAILURE MODE HERE IS BEING LOCKED OUT OF YOUR OWN ACCOUNT
 * ════════════════════════════════════════════════════════════════════════════
 * Everything below is about the two ways that happens: a code silently mangled
 * on the way out, or a device somebody needs being unreachable.
 *
 * The challenge fixture is the real payload captured from an enrolled account on
 * 2026-09-28 — two devices, `static` and `totp`, `last_used` populated on one.
 * The body asserted in the first test is the one a live server accepted.
 */

const onSubmit = vi.fn();
const onHandOver = vi.fn();

const challenge = (over: Record<string, unknown> = {}): AuthenticatorValidateChallenge =>
  authenticatorValidateChallengeSchema.parse({
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

const show = (over: Record<string, unknown> = {}, problem: string | null = null) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ auth: messages }}>
      <SecondFactor
        challenge={challenge(over)}
        email="maya@avivco.il"
        busy={false}
        problem={problem}
        onSubmit={onSubmit}
        onHandOver={onHandOver}
      />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  onSubmit.mockReset();
  onHandOver.mockReset();
});

describe('★★ the digit count is the constant’s to own, not the copy’s', () => {
  it('⚠⚠ no visible sentence names how many digits there are', async () => {
    /*
     * ═════════════════════════════════════════════════════════════════════════
     * THE HINT SAID “THE SIXTH DIGIT” IN TWO CATALOGUES
     * ═════════════════════════════════════════════════════════════════════════
     * `CODE_LENGTH` is measured from this deployment’s own `otpauth://` URL,
     * and a number the code owns was also written out in prose — in English and
     * in Hebrew. Change the constant and both sentences stay confidently wrong,
     * the boxes and the sentence disagree, and nothing anywhere reddens.
     *
     * ★ It asserts the RENDERED text rather than the catalogue string, so it
     *   also covers a future sentence that names the number somewhere else. The
     *   count is allowed to reach the screen twice — as the boxes themselves,
     *   which are visible and countable, and through `code.digit`’s `{of}`
     *   parameter, which is derived. Both track the constant; prose does not.
     */
    show();
    const boxes = screen.getAllByRole('textbox');

    // Not a word list: the assertion is that no VISIBLE sentence carries the
    // number, whatever word it is spelled with.
    const visible = document.body.textContent ?? '';
    expect(visible).not.toContain(String(boxes.length));
    for (const word of ['six', 'sixth', 'eight', 'eighth']) {
      expect(visible.toLowerCase(), word).not.toContain(word);
    }

    // Both directions: the count must still reach somebody who cannot see the
    // boxes, or this is satisfied by a screen that says nothing at all.
    expect(boxes[0]).toHaveAttribute('aria-label', `Digit 1 of ${boxes.length}`);
    expect(boxes.at(-1)).toHaveAttribute('aria-label', `Digit ${boxes.length} of ${boxes.length}`);
  });

  it('\u26a0\u26a0 and the Hebrew catalogue does not name it either', () => {
    /*
     * \u2605 THE DEFECT WAS IN BOTH CATALOGUES, SO ONE LOCALE IS HALF A TEST.
     * A guard that reads only English passes a Hebrew sentence that still says
     * \u201cthe sixth digit\u201d \u2014 and the Hebrew reader is the one it would be wrong
     * for.
     *
     * The numeral check is language-independent and carries no false-positive
     * risk. The word check covers the one spelling that was actually there;
     * it is not a claim to cover every way Hebrew can say six, because a word
     * list that reddens on correct copy gets weakened until it matches
     * nothing.
     */
    render(
      <NextIntlClientProvider locale="he" messages={{ auth: hebrewMessages }}>
        <SecondFactor
          challenge={challenge()}
          email="maya@avivco.il"
          busy={false}
          problem={null}
          onSubmit={onSubmit}
          onHandOver={onHandOver}
        />
      </NextIntlClientProvider>,
    );
    const visible = document.body.textContent ?? '';
    expect(visible).not.toContain('6');
    expect(visible).not.toContain('\u05e9\u05d9\u05e9\u05d9\u05ea');
    // Both directions: the Hebrew panel must actually have rendered.
    expect(visible).toContain(hebrewMessages.secondFactor.title);
  });
});

describe('the code, and the shape a real server accepted', () => {
  it('submits itself the moment the sixth digit lands, echoing the whole device', async () => {
    /*
     * ════════════════════════════════════════════════════════════════════════
     * THIS EXACT BODY WAS ACCEPTED BY THE LIVE STAGE ON 2026-09-28
     * ════════════════════════════════════════════════════════════════════════
     * A real TOTP code was submitted against the real `ak-stage-authenticator-
     * validate` on an enrolled account, and the flow advanced to
     * `ak-stage-user-login` with no `response_errors`. So the shape below is
     * confirmed rather than read off a schema — and the first person to use this
     * screen is not the first to test the contract.
     *
     * `selected_challenge` carries the device back **verbatim**: the confirmation
     * echoed exactly what the challenge handed over, unmodified.
     *
     * Auto-submitting on the sixth digit is 00b's own words, and it is safe here
     * in a way it would not be on the approvals queue: a wrong code costs a
     * retry, and making somebody press a button after the last digit of a code
     * that expires is friction with nothing behind it.
     */
    const user = userEvent.setup();
    show();
    await user.type(screen.getByTestId('code-0'), '123456');

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      component: 'ak-stage-authenticator-validate',
      selected_challenge: {
        device_class: 'totp',
        device_uid: '1',
        challenge: {},
        last_used: '2026-08-07T06:58:58.258317Z',
      },
      code: '123456',
    });
  });

  it('sends the code as a string, so a leading zero survives', async () => {
    /*
     * The trap two lines apart in Authentik's schema: `code` is a string when
     * validating and an integer when enrolling. Through an integer, `012345` is
     * `12345` — a failed sign-in nobody can explain, on the screen where failure
     * means lockout. The live confirmation sent a string and it was accepted.
     */
    const user = userEvent.setup();
    show();
    await user.type(screen.getByTestId('code-0'), '012345');
    expect(onSubmit.mock.calls[0]![0].code).toBe('012345');
    expect(typeof onSubmit.mock.calls[0]![0].code).toBe('string');
  });

  it('a pasted code fills every box, from whichever one has the cursor', async () => {
    /*
     * 00b asks for it, and somebody copying from an authenticator app pastes into
     * whichever box the cursor is in — not reliably the first.
     */
    const user = userEvent.setup();
    show();
    await user.click(screen.getByTestId('code-2'));
    await user.paste('654321');
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('ignores anything that is not a digit', async () => {
    const user = userEvent.setup();
    show();
    await user.type(screen.getByTestId('code-0'), 'a1b2c3d4e5f6');
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ code: '123456' }));
  });

  it('does not submit a short code', async () => {
    const user = userEvent.setup();
    show();
    await user.type(screen.getByTestId('code-0'), '12345');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('defaults to the most recently used device', async () => {
    // `totp` carries a `last_used`; the recovery codes do not. The familiar one
    // first is "never make somebody choose a method they cannot remember".
    show();
    expect(screen.getByTestId('second-factor')).toHaveAttribute('data-device', 'totp');
  });
});

describe('a recovery code is not six digits', () => {
  const recoveryOnly = {
    device_challenges: [
      { device_class: 'static', device_uid: '1', challenge: {}, last_used: null },
    ],
  };

  it('gets one field, not six boxes that would truncate it', async () => {
    /*
     * Nothing has been observed about a recovery code's length or alphabet — and
     * it is the one device class nobody has fired, because recovery codes are
     * single-use and burning one to confirm a field name is a bad trade. Six
     * boxes would silently take the first six characters of a longer code and
     * report it as wrong, to somebody who has already lost their phone.
     */
    show(recoveryOnly);
    expect(screen.getByTestId('recovery-code')).toBeInTheDocument();
    expect(screen.queryByTestId('code-0')).toBeNull();
  });

  it('does not auto-submit, because we do not know when it is complete', async () => {
    const user = userEvent.setup();
    show(recoveryOnly);
    await user.type(screen.getByTestId('recovery-code'), 'abcd-efgh-1234');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('sends it trimmed and whole, through the same code field', async () => {
    const user = userEvent.setup();
    show(recoveryOnly);
    await user.type(screen.getByTestId('recovery-code'), '  abcd-efgh-1234  ');
    await user.click(screen.getByRole('button', { name: /verify and continue/i }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ code: 'abcd-efgh-1234' }));
  });

  it('is never called "static" anywhere a reader can see', async () => {
    /*
     * Authentik's word for its own storage. Somebody who has these was shown ten
     * of them once and told to keep them safe; "recovery code" is the phrase they
     * were given.
     */
    const user = userEvent.setup();
    show();
    await user.click(screen.getByTestId('no-access'));
    expect(screen.getByTestId('use-static')).toHaveTextContent(/use a recovery code/i);
    expect(screen.queryByText(/\bstatic\b/i)).toBeNull();
  });
});

describe('one device means no chooser, and the way out is still there', () => {
  it('offers no chooser when there is one device', async () => {
    /*
     * The common path is a person with an authenticator app, and a list of one is
     * a decision nobody needs to make.
     */
    show({
      device_challenges: [
        { device_class: 'totp', device_uid: '1', challenge: {}, last_used: null },
      ],
    });
    expect(screen.queryByTestId('no-access')).toBeNull();
    expect(screen.getByTestId('code-0')).toBeInTheDocument();
  });

  it('shows the way out as the situation, not as a menu label', async () => {
    /*
     * "No access to your phone?" costs nothing to the person holding theirs, and
     * is the sentence somebody who has lost it is already thinking.
     */
    show();
    expect(screen.getByTestId('no-access')).toHaveTextContent(/no access to your phone/i);
    expect(screen.queryByTestId('other-methods')).toBeNull();
  });

  it('switches to the recovery code when it is chosen', async () => {
    const user = userEvent.setup();
    show();
    await user.click(screen.getByTestId('no-access'));
    await user.click(screen.getByTestId('use-static'));
    expect(screen.getByTestId('recovery-code')).toBeInTheDocument();
    expect(onHandOver).not.toHaveBeenCalled();
  });

  it('stops asking about the phone once they have answered that question', async () => {
    /*
     * ════════════════════════════════════════════════════════════════════════
     * A STATE A BROWSER WALK MADE REACHABLE, NOT A HYPOTHETICAL
     * ════════════════════════════════════════════════════════════════════════
     * The admin account has exactly `totp` and `static`, so this is one click
     * from where the walk landed: press "No access to your phone?", choose the
     * recovery code, and the link underneath asked **the same question again** —
     * of somebody who has already answered it and is now typing a recovery code.
     *
     * The label follows the active device. It stays "No access to your phone?"
     * while the phone is the thing in use, and becomes a neutral way back
     * afterwards.
     */
    const user = userEvent.setup();
    show();
    await user.click(screen.getByTestId('no-access'));
    await user.click(screen.getByTestId('use-static'));

    const wayOut = screen.getByTestId('no-access');
    expect(wayOut).toHaveTextContent(/use a different method/i);
    expect(wayOut).not.toHaveTextContent(/no access to your phone/i);
  });

  it('offers the way back, so choosing the recovery code is not a dead end', async () => {
    /*
     * Somebody who clicks through to recovery codes and then finds their phone
     * must be able to return. Without this the only route back is reloading the
     * page, which restarts the flow and costs them the password they just typed.
     */
    const user = userEvent.setup();
    show();
    await user.click(screen.getByTestId('no-access'));
    await user.click(screen.getByTestId('use-static'));
    await user.click(screen.getByTestId('no-access'));
    await user.click(screen.getByTestId('use-totp'));
    expect(screen.getByTestId('code-0')).toBeInTheDocument();
  });
});

describe('the three classes we have not built hand over rather than guess', () => {
  it('hands over when the only device is one we have never observed', async () => {
    /*
     * A security key is a browser credential prompt, not a code — and the schema
     * agrees by giving `webauthn` its own object field rather than sharing
     * `code`. Rendering a code box for it would fail after the typing, on the
     * screen where failure means lockout.
     */
    show({
      device_challenges: [
        { device_class: 'webauthn', device_uid: '2', challenge: {}, last_used: null },
      ],
    });
    expect(onHandOver).toHaveBeenCalled();
    expect(screen.queryByTestId('code-0')).toBeNull();
  });

  it('hands over when one is chosen from the list, and says so in the label', async () => {
    const user = userEvent.setup();
    show({
      device_challenges: [
        { device_class: 'totp', device_uid: '1', challenge: {}, last_used: '2026-08-07T06:58:58Z' },
        { device_class: 'duo', device_uid: '2', challenge: {}, last_used: null },
      ],
    });
    await user.click(screen.getByTestId('no-access'));
    expect(screen.getByTestId('use-duo')).toHaveTextContent(/continues at your sign-in provider/i);
    await user.click(screen.getByTestId('use-duo'));
    expect(onHandOver).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('a class nobody has named still gets a label rather than its raw value', async () => {
    const user = userEvent.setup();
    show({
      device_challenges: [
        { device_class: 'totp', device_uid: '1', challenge: {}, last_used: '2026-08-07T06:58:58Z' },
        { device_class: 'passkey', device_uid: '9', challenge: {}, last_used: null },
      ],
    });
    await user.click(screen.getByTestId('no-access'));
    const other = screen.getByTestId('use-passkey');
    expect(other).toHaveTextContent(/another method/i);
    expect(other).not.toHaveTextContent('passkey');
  });
});

describe('who it says you are', () => {
  it('shows the address they typed, never the server username', async () => {
    /*
     * `pending_user` is `akadmin` — a username that reads as an internal system
     * account to somebody halfway through signing in. What they typed a moment
     * ago is always recognisable to them and cannot leak an account name.
     */
    show();
    expect(screen.getByText(/maya@avivco\.il/)).toBeInTheDocument();
    expect(screen.queryByText(/akadmin/)).toBeNull();
  });

  it('shows the stage own error, and stays put', async () => {
    show({}, 'Invalid code.');
    expect(screen.getByTestId('second-factor-problem')).toHaveTextContent('Invalid code.');
    expect(screen.getByTestId('code-0')).toBeInTheDocument();
  });
});

describe('⚠⚠ what the reviewer saw first: a label with nothing after it', () => {
  it('⚠⚠ says nothing rather than "Signing in as " when the address is unknown', () => {
    /*
     * ════════════════════════════════════════════════════════════════════════
     * THE STAGE OUTLIVES THE ADDRESS
     * ════════════════════════════════════════════════════════════════════════
     * `startFlow()` resumes whatever stage the flow cookie holds, so a reload
     * lands on this screen with the panel's `email` state empty — nobody typed
     * it in that page load. The stage is server-side; the typed value was only
     * in React.
     *
     * A label with an empty value reads as a broken screen rather than as a
     * missing fact. Three states, never two.
     */
    render(
      <NextIntlClientProvider locale="en" messages={{ auth: messages }}>
        <SecondFactor
          challenge={challenge()}
          email=""
          busy={false}
          problem={null}
          onSubmit={onSubmit}
          onHandOver={onHandOver}
        />
      </NextIntlClientProvider>,
    );
    expect(screen.queryByText(/signing in as/i)).toBeNull();
    // And the screen is still usable: the code boxes are the point of it.
    expect(screen.getByTestId('code-0')).toBeInTheDocument();
  });

  it('★★ and still names them when it does know, which is the whole ruling', () => {
    // Both directions. Omitting always would satisfy the assertion above and
    // throw away the reassurance the line exists to give.
    show();
    expect(screen.getByText(/maya@avivco\.il/)).toBeInTheDocument();
  });

  it('⚠ never falls back to the server’s username', () => {
    /*
     * The challenge carries `pending_user: 'akadmin'`. Filling the gap with it
     * would put an internal account name in front of somebody halfway through
     * signing in — ruled out, and a wrong name is worse than no name.
     */
    render(
      <NextIntlClientProvider locale="en" messages={{ auth: messages }}>
        <SecondFactor
          challenge={challenge()}
          email=""
          busy={false}
          problem={null}
          onSubmit={onSubmit}
          onHandOver={onHandOver}
        />
      </NextIntlClientProvider>,
    );
    expect(screen.queryByText(/akadmin/i)).toBeNull();
  });
});

describe('⚠⚠ "make it all the length of the button" — 00b’s mock', () => {
  /*
   * ════════════════════════════════════════════════════════════════════════
   * `flex:1` IS THE RULE. 60px IS WHAT IT COMES TO AT 400px.
   * ════════════════════════════════════════════════════════════════════════
   *     mock  flex:1; height:60px; border-radius:12px;
   *           font-size:26px; font-weight:600; row gap:8px
   *     was   44px fixed, body size — six of those plus five gaps is 304px
   *           inside a 400px column, so the row stopped short of the button
   *
   * Asserted from the stylesheet, because a literal there has nothing behind
   * it — the same reason 00a's quoted values are pinned.
   */
  const css = readFileSync('src/features/auth/SecondFactor.module.css', 'utf8');
  const declaration = (selector: string, property: string): string | undefined => {
    const block = new RegExp(`\\.${selector}\\s*\\{([^}]*)\\}`).exec(css)?.[1];
    return new RegExp(`(?:^|;|\\n)\\s*${property}\\s*:\\s*([^;]+)`).exec(block ?? '')?.[1]?.trim();
  };

  it('⚠⚠ the boxes divide the row rather than having a width of their own', () => {
    expect(declaration('box', 'flex')).toBe('1');
    // Without this a flex item will not shrink below its content and the row
    // overflows instead of fitting.
    expect(declaration('box', 'min-inline-size')).toBe('0');
    expect(declaration('box', 'inline-size')).toBeUndefined();
  });

  it('★★ and they are the design’s square, at the design’s digit size', () => {
    expect(declaration('box', 'block-size')).toBe('60px');
    expect(declaration('box', 'font-size')).toBe('var(--font-size-code-box)');
    expect(declaration('box', 'font-weight')).toBe('var(--font-weight-semibold)');
    expect(declaration('box', 'border-radius')).toBe('var(--radius-code-box)');
  });

  it('★ the tokens carry the mock’s own numbers', () => {
    // 26px and 12px, added to the scale rather than written into this screen —
    // 00b is not the last screen that will have a code box.
    const tokens = readFileSync('src/design-system/tokens/tokens.css', 'utf8');
    expect(tokens).toMatch(/--font-size-code-box:\s*26px/);
    expect(tokens).toMatch(/--radius-code-box:\s*12px/);
    /*
     * And the fixed width that caused this is gone, not left to be reused.
     *
     * ⚠ Anchored to a DECLARATION. The first version matched the name
     *   anywhere and failed on the comment that explains the removal — a
     *   true match against the wrong object, which is the shape that has cost
     *   most today.
     */
    expect(tokens).not.toMatch(/^\s*--size-code-box:/m);
  });
});

describe('⚠⚠ the account at the top, with a way back', () => {
  /*
   * ════════════════════════════════════════════════════════════════════════
   * "עדיין אין את שם המשתמש למעלה עם אופציה לחזור"
   * ════════════════════════════════════════════════════════════════════════
   * The address was BELOW the heading as "Signing in as …" and there was no
   * way back at all. The mock puts it above with an `arrow-left`.
   *
   * ★ "Back" cannot be a link to the previous page: the stage lives in a
   *   server-side flow, so returning to `/sign-in` resumes THIS stage. The
   *   provider hands us the way out on the challenge —
   *   `flow_info.cancel_url` — which our contract has parsed since it was
   *   written and nothing had ever read.
   */
  const withCancel = (over: Record<string, unknown> = {}) =>
    challenge({ flow_info: { title: 'Sign in', cancel_url: '/flows/-/cancel/' }, ...over });

  const render00b = (email: string, ch = withCancel()) =>
    render(
      <NextIntlClientProvider locale="en" messages={{ auth: messages }}>
        <SecondFactor
          challenge={ch}
          email={email}
          busy={false}
          problem={null}
          onSubmit={onSubmit}
          onHandOver={onHandOver}
        />
      </NextIntlClientProvider>,
    );

  it('⚠⚠ shows the address above the heading, linked to the provider’s way out', () => {
    render00b('maya@avivco.il');
    const back = screen.getByTestId('second-factor-back');
    expect(back).toHaveAttribute('href', '/flows/-/cancel/');
    expect(back).toHaveTextContent('maya@avivco.il');
  });

  it('⚠⚠ it comes BEFORE the heading, which is the whole complaint', () => {
    /*
     * Order, not presence. The address was already on the screen — underneath.
     * `compareDocumentPosition` is the assertion that would have failed on the
     * version he was looking at.
     */
    render00b('maya@avivco.il');
    const back = screen.getByTestId('second-factor-back');
    const heading = screen.getByRole('heading', { level: 1 });
    expect(back.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('⚠⚠ renders nothing when the provider offers no way out', () => {
    /*
     * `cancel_url` defaults to '' and its value has never been observed live.
     * A back arrow that silently does nothing, on a screen somebody is stuck
     * on, is worse than no arrow. Three states, never two.
     */
    render00b('maya@avivco.il', challenge());
    expect(screen.queryByTestId('second-factor-back')).toBeNull();
  });

  it('★ still offers the way out when the address is unknown', () => {
    // A resumed flow has no typed email. The affordance is about leaving, not
    // about identity, so it survives — with words instead of an address.
    render00b('');
    const back = screen.getByTestId('second-factor-back');
    expect(back).toBeInTheDocument();
    expect(back).not.toHaveTextContent('@');
  });

  it('★★ and it says what it does, for anyone who cannot see an arrow', () => {
    // "maya@avivco.il" beside a glyph does not say what pressing it will do.
    render00b('maya@avivco.il');
    expect(screen.getByTestId('second-factor-back')).toHaveTextContent(/use a different account/i);
  });

  it('⚠ never links to a cancel path the provider did not send', () => {
    /*
     * It is a path on the identity provider's origin. Composing one ourselves
     * is the absolute-path defect this repository has had three times, and
     * `safeLinkUrl` is what refuses a value that is not a path or a URL.
     */
    render00b('maya@avivco.il', withCancel({ flow_info: { cancel_url: 'javascript:alert(1)' } }));
    expect(screen.queryByTestId('second-factor-back')).toBeNull();
  });
});
