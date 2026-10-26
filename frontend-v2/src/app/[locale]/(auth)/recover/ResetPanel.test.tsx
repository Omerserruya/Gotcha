import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readChallenge } from '@/api/contracts/auth-flow';
import messages from '@/i18n/messages/en/auth.json';
import heMessages from '@/i18n/messages/he/auth.json';

import { CAPTURED } from '@/api/contracts/recovery-capture';

/**
 * Screen two, against what dev answers (recovery-capture.ts). The executor is
 * mocked and answers with the REAL parser over the captured bodies; nothing
 * here reaches a provider or changes a password.
 */
const startFlow = vi.hoisted(() => vi.fn());
const submitStage = vi.hoisted(() => vi.fn());
vi.mock('@/api/client/flow-executor', () => ({ startFlow, submitStage }));
const acceptSetupTerms = vi.hoisted(() => vi.fn());
vi.mock('@/api/client/setup-consent', () => ({ acceptSetupTerms }));

const { ResetPanel } = await import('./ResetPanel');

const step = (raw: unknown) => readChallenge(raw);
const accepted = (raw: unknown) => ({ ok: true, step: step(raw) });
const TOKEN = 'tok_ABCdef123456';
const QUERY = `flow_token=${TOKEN}`;
const GOOD = 'Abcdefgh1!xyz';
/** Our own setup token: a setup link's, exchanged for TOKEN once the terms are accepted. */
const SETUP = 'setup_XYZuvw987654';

function show(
  purpose: 'reset' | 'setup' = 'reset',
  locale: 'en' | 'he' = 'en',
  flow = purpose === 'reset' ? 'gotcha-recovery-self' : 'gotcha-recovery',
  link: { kind: 'flow' | 'setup'; token: string } = purpose === 'setup'
    ? { kind: 'setup', token: SETUP }
    : { kind: 'flow', token: TOKEN },
) {
  return render(
    <NextIntlClientProvider
      locale={locale}
      messages={{ auth: locale === 'en' ? messages : heMessages }}
    >
      <ResetPanel
        flow={flow}
        link={link}
        purpose={purpose}
        loginHref="/api/auth/login?handover=1&finish=1"
        signInHref="/en/sign-in"
        recoverHref={purpose === 'reset' ? `/en/recover?flow=${flow}` : null}
      />
    </NextIntlClientProvider>,
  );
}

/** Continue; on a setup link, the terms are ticked first, as they must be. */
const open = async () => {
  const box = screen.queryByTestId('reset-terms-box');
  if (box && !(box as HTMLInputElement).checked) await userEvent.click(box);
  await userEvent.click(screen.getByTestId('reset-open'));
};
const fill = async (password: string, repeat = password) => {
  fireEvent.change(await screen.findByTestId('reset-password'), { target: { value: password } });
  fireEvent.change(screen.getByTestId('reset-password_repeat'), { target: { value: repeat } });
};
const save = () => userEvent.click(screen.getByRole('button', { name: 'Save the password' }));

beforeEach(() => {
  vi.clearAllMocks();
  startFlow.mockImplementation(async () => {
    throw new Error('the executor must be asked only by a test that says so');
  });
  submitStage.mockImplementation(async () => {
    throw new Error('the executor must be asked only by a test that says so');
  });
  // Recorded, and the provider's token for the setup flow (services/auth setup-link.ts).
  acceptSetupTerms.mockResolvedValue({
    kind: 'recovery',
    flow: 'gotcha-recovery',
    flowToken: TOKEN,
  });
  window.history.replaceState(
    null,
    '',
    `/en/recover?flow=gotcha-recovery-self&flow_token=${TOKEN}`,
  );
});

describe('★★ the link is not spent until its owner presses Continue', () => {
  it('asks the executor nothing on load: a scanner that runs the page spends nothing', async () => {
    show();
    await new Promise((r) => setTimeout(r, 20));
    expect(startFlow).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Choose a new password');
  });

  it('takes the token out of the address bar at once, and keeps the flow', () => {
    show();
    expect(window.location.search).toBe('?flow=gotcha-recovery-self');
  });

  it('a setup link says "Set your password"', () => {
    show('setup');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Set your password');
  });
});

describe('opening the link', () => {
  it('a reset: GET with the token, answers consent with ITS token, then the form for that address', async () => {
    startFlow.mockResolvedValueOnce(step(CAPTURED.consent));
    submitStage.mockResolvedValueOnce(accepted(CAPTURED.prompt));
    show();
    await open();
    expect(startFlow).toHaveBeenCalledWith('gotcha-recovery-self', QUERY);
    expect(submitStage).toHaveBeenCalledWith(
      { component: 'ak-stage-consent', token: 'consent-token-1' },
      'gotcha-recovery-self',
      QUERY,
    );
    expect(await screen.findByTestId('reset-form')).toHaveTextContent(
      'For gotcha.dev.test@gmail.com.',
    );
  });

  it('an invite opens on the prompt itself: no consent is posted', async () => {
    startFlow.mockResolvedValueOnce(step(CAPTURED.prompt));
    show('setup');
    await open();
    expect(await screen.findByTestId('reset-form')).toBeInTheDocument();
    expect(submitStage).not.toHaveBeenCalled();
  });

  it('★ a dead reset token (the flow restarts at identification) is "expired", with a new link', async () => {
    startFlow.mockResolvedValueOnce(step(CAPTURED.identification));
    show();
    await open();
    expect(await screen.findByTestId('reset-expired')).toHaveTextContent(
      'This link has expired or was already used',
    );
    expect(screen.getByTestId('reset-resend')).toHaveAttribute(
      'href',
      '/en/recover?flow=gotcha-recovery-self',
    );
  });

  it('anything but consent or the prompt, with a token in hand, is "expired" too', async () => {
    startFlow.mockResolvedValueOnce(step(CAPTURED.accessDenied));
    show();
    await open();
    expect(await screen.findByTestId('reset-expired')).toBeInTheDocument();
  });

  it('no answer: says so, and Continue stays to try again', async () => {
    startFlow.mockResolvedValueOnce(null);
    show();
    await open();
    expect(await screen.findByTestId('reset-unreachable')).toHaveTextContent(
      'We could not reach the sign-in service.',
    );
    expect(screen.getByTestId('reset-open')).toBeEnabled();
  });

  it('a prompt asking for more than the two passwords is not drawn', async () => {
    startFlow.mockResolvedValueOnce(
      step({
        ...CAPTURED.prompt,
        fields: [...CAPTURED.prompt.fields, { field_key: 'name', type: 'text', required: true }],
      }),
    );
    show('setup');
    await open();
    expect(await screen.findByTestId('reset-unexpected')).toBeInTheDocument();
  });
});

describe('★ the form', () => {
  beforeEach(() => {
    startFlow.mockResolvedValue(step(CAPTURED.prompt));
  });

  it('the checklist ticks as the password is typed; the breach rule waits for the server', async () => {
    show('setup');
    await open();
    await fill('abc');
    expect(screen.getByTestId('reset-rule-lower')).toHaveAttribute('data-met', 'yes');
    expect(screen.getByTestId('reset-rule-upper')).toHaveAttribute('data-met', 'no');
    expect(screen.getByTestId('reset-rule-length')).toHaveTextContent('At least 12 characters');
    await fill(GOOD);
    for (const rule of ['length', 'upper', 'lower', 'digit', 'symbol']) {
      expect(screen.getByTestId(`reset-rule-${rule}`)).toHaveAttribute('data-met', 'yes');
    }
    expect(screen.getByTestId('reset-rule-leaked')).toHaveAttribute('data-met', 'unknown');
  });

  it.each([
    ['', '', 'Fill in both fields.'],
    ['abc', 'abc', 'The password does not meet every rule above yet.'],
    [GOOD, `${GOOD}x`, 'The two passwords are not the same.'],
  ])('says early what the server would say, and sends nothing (%s / %s)', async (p, r, words) => {
    show('setup');
    await open();
    await fill(p, r);
    await save();
    expect(screen.getByTestId('reset-problem')).toHaveTextContent(words);
    expect(submitStage).not.toHaveBeenCalled();
  });

  it('a mismatch marks the repeat field, not the password', async () => {
    show('setup');
    await open();
    await fill(GOOD, `${GOOD}x`);
    await save();
    expect(screen.getByTestId('reset-password_repeat')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByTestId('reset-password')).toHaveAttribute('aria-invalid', 'false');
  });

  it.each([
    [CAPTURED.promptBreached, 'This password has appeared in a data leak.'],
    [CAPTURED.promptRules, 'The password does not meet every rule above yet.'],
    [CAPTURED.promptWeak, 'This password is too easy to guess.'],
  ])('★ the server’s refusal, in our words, and what was typed stays', async (raw, words) => {
    submitStage.mockResolvedValueOnce(accepted(raw));
    show('setup');
    await open();
    await fill(GOOD);
    await save();
    expect(submitStage).toHaveBeenCalledWith(
      { component: 'ak-stage-prompt', password: GOOD, password_repeat: GOOD },
      'gotcha-recovery',
      QUERY,
    );
    expect(await screen.findByTestId('reset-problem')).toHaveTextContent(words);
    expect(screen.getByTestId('reset-problem')).not.toHaveTextContent(
      'Add another word or two. Uncommon',
    );
    expect(screen.getByTestId<HTMLInputElement>('reset-password').value).toBe(GOOD);
  });

  it('a lost submit keeps what was typed and says so', async () => {
    submitStage.mockResolvedValueOnce({ ok: false });
    show('setup');
    await open();
    await fill(GOOD);
    await save();
    expect(await screen.findByTestId('reset-problem')).toHaveTextContent(
      'What you typed is still here.',
    );
    expect(screen.getByTestId<HTMLInputElement>('reset-password').value).toBe(GOOD);
  });

  it('each field has its own eye, and it shows only that field', async () => {
    show('setup');
    await open();
    await fill(GOOD);
    await userEvent.click(screen.getByTestId('reset-reveal-password'));
    expect(screen.getByTestId('reset-password')).toHaveAttribute('type', 'text');
    expect(screen.getByTestId('reset-password_repeat')).toHaveAttribute('type', 'password');
    expect(screen.getByTestId('reset-reveal-password')).toHaveAttribute('aria-pressed', 'true');
  });

  it('both fields ask a password manager for a NEW password', async () => {
    show('setup');
    await open();
    for (const id of ['reset-password', 'reset-password_repeat']) {
      expect(await screen.findByTestId(id)).toHaveAttribute('autocomplete', 'new-password');
    }
  });
});

describe('★ after the submit', () => {
  beforeEach(() => {
    startFlow.mockResolvedValue(step(CAPTURED.prompt));
  });

  it('saved and signed in at the provider: "stay signed in" is answered NO, and Continue completes the app’s sign-in', async () => {
    submitStage
      .mockResolvedValueOnce(accepted(CAPTURED.userLogin))
      .mockResolvedValueOnce(accepted(CAPTURED.redirect));
    show('setup');
    await open();
    await fill(GOOD);
    await save();
    expect(await screen.findByTestId('reset-done')).toHaveTextContent('Your password is set');
    expect(submitStage).toHaveBeenLastCalledWith(
      // Sign-in's own body for this stage, proven on dev (staySignedInBody).
      { remember_me: false },
      'gotcha-recovery',
      QUERY,
    );
    expect(screen.getByTestId('reset-continue')).toHaveAttribute(
      'href',
      '/api/auth/login?handover=1&finish=1',
    );
    expect(screen.getByTestId('reset-continue')).toHaveTextContent('Continue to GOTCHA');
  });

  it('a reset says "Password changed"', async () => {
    startFlow.mockResolvedValue(step(CAPTURED.consent));
    submitStage
      .mockResolvedValueOnce(accepted(CAPTURED.prompt))
      .mockResolvedValueOnce(accepted(CAPTURED.userLogin))
      .mockResolvedValueOnce(accepted(CAPTURED.redirect));
    show('reset');
    await open();
    await fill(GOOD);
    await save();
    expect(await screen.findByTestId('reset-done')).toHaveTextContent('Password changed');
  });

  it('saved, but the sign-in step was lost: the password is set, and the way on is Sign in', async () => {
    submitStage
      .mockResolvedValueOnce(accepted(CAPTURED.userLogin))
      .mockResolvedValueOnce({ ok: false });
    show('setup');
    await open();
    await fill(GOOD);
    await save();
    expect(await screen.findByTestId('reset-done')).toBeInTheDocument();
    expect(screen.getByTestId('reset-continue')).toHaveAttribute('href', '/en/sign-in');
  });

  it('★ a dead invite, found out on submit: "expired", what was typed is gone, and no resend from here', async () => {
    submitStage.mockResolvedValueOnce(accepted(CAPTURED.accessDenied));
    show('setup');
    await open();
    await fill(GOOD);
    await save();
    expect(await screen.findByTestId('reset-expired')).toHaveTextContent(
      'Ask whoever invited you to send a new one.',
    );
    expect(screen.queryByTestId('reset-resend')).toBeNull();
    expect(screen.queryByDisplayValue(GOOD)).toBeNull();
  });
});

describe('Hebrew', () => {
  it('reads in Hebrew, and the address is set apart from the sentence', async () => {
    startFlow.mockResolvedValueOnce(step(CAPTURED.consent));
    submitStage.mockResolvedValueOnce(accepted(CAPTURED.prompt));
    show('reset', 'he');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('בחירת סיסמה חדשה');
    await open();
    const form = await screen.findByTestId('reset-form');
    await waitFor(() =>
      expect(form.querySelector('bdi')).toHaveTextContent('gotcha.dev.test@gmail.com'),
    );
    expect(screen.getByTestId('reset-rule-length')).toHaveTextContent('לפחות 12 תווים');
  });
});

describe('the breach row agrees with the breach refusal', () => {
  it('reads failed while the field holds the refused password, and unknown once it changes', async () => {
    startFlow.mockResolvedValue(step(CAPTURED.prompt));
    submitStage.mockResolvedValueOnce(accepted(CAPTURED.promptBreached));
    show('setup');
    await open();
    await fill(GOOD);
    const row = () => screen.getByTestId('reset-rule-leaked');
    expect(row()).toHaveAttribute('data-met', 'unknown');
    await save();
    await waitFor(() => expect(row()).toHaveAttribute('data-met', 'failed'));
    expect(row()).toHaveTextContent('(Not met)');
    await fill(`${GOOD}z`);
    expect(row()).toHaveAttribute('data-met', 'unknown');
  });

  it('another refusal does not mark it', async () => {
    startFlow.mockResolvedValue(step(CAPTURED.prompt));
    submitStage.mockResolvedValueOnce(accepted(CAPTURED.promptWeak));
    show('setup');
    await open();
    await fill(GOOD);
    await save();
    await screen.findByTestId('reset-problem');
    expect(screen.getByTestId('reset-rule-leaked')).toHaveAttribute('data-met', 'unknown');
  });
});

describe('★★ a first password accepts the Terms and the Privacy Policy first (Omer, 2026-10-26)', () => {
  const box = () => screen.getByTestId('reset-terms-box') as HTMLInputElement;
  const tick = () => userEvent.click(box());
  const go = () => userEvent.click(screen.getByTestId('reset-open'));

  beforeEach(() => {
    window.history.replaceState(null, '', `/en/recover?flow=gotcha-recovery&setup=${SETUP}`);
  });

  it('a setup link shows the box unticked, and Continue cannot be pressed until it is', async () => {
    show('setup');
    expect(box()).not.toBeChecked();
    expect(box()).toBeRequired();
    expect(screen.getByTestId('reset-open')).toBeDisabled();
    await go();
    expect(acceptSetupTerms).not.toHaveBeenCalled();
    expect(startFlow).not.toHaveBeenCalled();
    await tick();
    expect(screen.getByTestId('reset-open')).toBeEnabled();
    await tick();
    expect(screen.getByTestId('reset-open')).toBeDisabled();
  });

  it("the links are the trust site's terms and privacy pages, each in a new tab", () => {
    show('setup');
    const terms = screen.getByTestId('reset-terms-link');
    const privacy = screen.getByTestId('reset-privacy-link');
    expect(terms).toHaveAttribute('href', 'https://trust.gotcha.co.il/terms-of-service');
    expect(privacy).toHaveAttribute('href', 'https://trust.gotcha.co.il/privacy-policy');
    for (const link of [terms, privacy]) {
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noreferrer');
    }
    expect(terms).toHaveTextContent(/^Terms of Service$/);
    expect(privacy).toHaveTextContent(/^Privacy Policy$/);
  });

  it('Continue records the acceptance, with the label as shown, BEFORE the flow is started with the token it returns', async () => {
    startFlow.mockResolvedValueOnce(step(CAPTURED.prompt));
    show('setup');
    await tick();
    await go();
    expect(await screen.findByTestId('reset-form')).toBeInTheDocument();
    expect(acceptSetupTerms).toHaveBeenCalledExactlyOnceWith(SETUP, {
      terms: true,
      privacy: true,
      locale: 'en',
      capturedText: 'I have read and agree to the Terms of Service and the Privacy Policy',
    });
    expect(startFlow).toHaveBeenCalledWith('gotcha-recovery', QUERY);
    expect(acceptSetupTerms.mock.invocationCallOrder[0]).toBeLessThan(
      startFlow.mock.invocationCallOrder[0]!,
    );
  });

  it('the save carries the token the acceptance returned', async () => {
    startFlow.mockResolvedValueOnce(step(CAPTURED.prompt));
    submitStage
      .mockResolvedValueOnce(accepted(CAPTURED.userLogin))
      .mockResolvedValueOnce(accepted(CAPTURED.redirect));
    show('setup');
    await open();
    await fill(GOOD);
    await save();
    expect(submitStage).toHaveBeenNthCalledWith(
      1,
      { component: 'ak-stage-prompt', password: GOOD, password_repeat: GOOD },
      'gotcha-recovery',
      QUERY,
    );
  });

  it('takes the setup token out of the address bar at once', () => {
    show('setup');
    expect(window.location.search).toBe('?flow=gotcha-recovery');
  });

  it('not reached: says so, the box stays ticked, nothing is started, and Continue tries again', async () => {
    acceptSetupTerms.mockResolvedValueOnce({ kind: 'unreachable' });
    show('setup');
    await tick();
    await go();
    expect(await screen.findByTestId('reset-unreachable')).toBeInTheDocument();
    expect(box()).toBeChecked();
    expect(screen.getByTestId('reset-open')).toBeEnabled();
    expect(startFlow).not.toHaveBeenCalled();
  });

  it('a dead setup link is "expired", with the invite\'s wording and no resend', async () => {
    acceptSetupTerms.mockResolvedValueOnce({ kind: 'expired' });
    show('setup');
    await open();
    expect(await screen.findByTestId('reset-expired')).toHaveTextContent(
      'Ask whoever invited you to send a new one.',
    );
    expect(screen.queryByTestId('reset-resend')).toBeNull();
    expect(startFlow).not.toHaveBeenCalled();
  });

  it('a password already set: says so, and the way on is our own sign-in', async () => {
    acceptSetupTerms.mockResolvedValueOnce({ kind: 'hasPassword' });
    show('setup');
    await open();
    expect(await screen.findByTestId('reset-has-password')).toHaveTextContent(
      'You already have a password',
    );
    expect(screen.getByTestId('reset-continue')).toHaveAttribute('href', '/en/sign-in');
    expect(startFlow).not.toHaveBeenCalled();
  });

  it('a refusal it cannot fix is "unexpected", and nothing is started', async () => {
    acceptSetupTerms.mockResolvedValueOnce({ kind: 'refused' });
    show('setup');
    await open();
    expect(await screen.findByTestId('reset-unexpected')).toBeInTheDocument();
    expect(startFlow).not.toHaveBeenCalled();
  });

  it('★ a setup link carrying the provider\'s token (minted before this) is "expired": no box that records nothing', () => {
    show('setup', 'en', 'gotcha-recovery', { kind: 'flow', token: TOKEN });
    expect(screen.getByTestId('reset-expired')).toBeInTheDocument();
    expect(screen.queryByTestId('reset-terms')).toBeNull();
    expect(screen.queryByTestId('reset-open')).toBeNull();
  });

  it('a reset has no box: Continue opens the link as before, and nothing is accepted', async () => {
    startFlow.mockResolvedValueOnce(step(CAPTURED.consent));
    submitStage.mockResolvedValueOnce(accepted(CAPTURED.prompt));
    show('reset');
    expect(screen.queryByTestId('reset-terms')).toBeNull();
    expect(screen.getByTestId('reset-open')).toBeEnabled();
    await go();
    expect(await screen.findByTestId('reset-form')).toBeInTheDocument();
    expect(acceptSetupTerms).not.toHaveBeenCalled();
  });

  it('in Hebrew: the first person, past tense (no gendered form), and the record says so', async () => {
    startFlow.mockResolvedValueOnce(step(CAPTURED.prompt));
    show('setup', 'he');
    expect(screen.getByTestId('reset-terms')).toHaveTextContent(
      'קראתי ואישרתי את תנאי השירות ואת מדיניות הפרטיות',
    );
    expect(screen.getByTestId('reset-terms-link')).toHaveTextContent(/^תנאי השירות$/);
    expect(screen.getByTestId('reset-privacy-link')).toHaveTextContent(/^מדיניות הפרטיות$/);
    expect(screen.getByTestId('reset-terms-link')).toHaveAttribute(
      'href',
      'https://trust.gotcha.co.il/he/terms-of-service',
    );
    expect(screen.getByTestId('reset-privacy-link')).toHaveAttribute(
      'href',
      'https://trust.gotcha.co.il/he/privacy-policy',
    );
    await open();
    await screen.findByTestId('reset-form');
    expect(acceptSetupTerms).toHaveBeenCalledWith(SETUP, {
      terms: true,
      privacy: true,
      locale: 'he',
      capturedText: 'קראתי ואישרתי את תנאי השירות ואת מדיניות הפרטיות',
    });
  });
});
