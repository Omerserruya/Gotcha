import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FlowStep } from '@/api/contracts/auth-flow';
import messages from '@/i18n/messages/en/auth.json';

/**
 * Password recovery, screen one.
 *
 * ★ The design has no recovery screen — 69 rendered frames in
 *   `Directions.dc.html` and not one heading mentions reset, recovery, forgot
 *   or password. So these tests pin BEHAVIOUR rather than a mock's values;
 *   there are none to pin.
 */
const startFlow = vi.hoisted(() => vi.fn());
const submitStage = vi.hoisted(() => vi.fn());

vi.mock('@/api/client/flow-executor', () => ({ startFlow, submitStage }));

const { RecoverPanel } = await import('./RecoverPanel');

const FLOW = 'gotcha-recovery-self';

const identifyOnly = (errors: Record<string, unknown> = {}): FlowStep => ({
  kind: 'identifyOnly',
  challenge: {
    component: 'ak-stage-identification',
    user_fields: ['email', 'username'],
    password_fields: false,
    primary_action: 'Continue',
    sources: [],
    response_errors: errors,
  } as never,
});

const show = () =>
  render(
    <NextIntlClientProvider locale="en" messages={{ auth: messages }}>
      <RecoverPanel flow={FLOW} signInHref="/v2/en/sign-in" />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  startFlow.mockResolvedValue(identifyOnly());
  submitStage.mockResolvedValue({ ok: true, step: { kind: 'handOver', because: 'sent' } });
});

describe('⚠⚠ the screen "Forgot it?" now reaches', () => {
  it('★★ drives the RECOVERY flow, not the authentication one', async () => {
    /*
     * The whole point. `startFlow()` with no argument opens the sign-in flow —
     * which would show this person a password field on a screen they reached
     * because they do not have the password.
     */
    show();
    await waitFor(() => expect(startFlow).toHaveBeenCalledWith(FLOW));
  });

  it('⚠⚠ asks for an address and nothing else', async () => {
    show();
    expect(await screen.findByTestId('recover-email')).toBeInTheDocument();
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });

  it('⚠⚠ draws nothing until the flow has actually started', async () => {
    /*
     * Rendering the form early would let somebody type an address into a flow
     * that has not opened, and the submit would start a fresh one underneath
     * them — the symptom being a stage that repeats.
     */
    let release!: (step: FlowStep) => void;
    startFlow.mockReturnValue(new Promise<FlowStep>((resolve) => (release = resolve)));

    show();
    expect(screen.queryByTestId('recover-form')).toBeNull();

    release(identifyOnly());
    expect(await screen.findByTestId('recover-form')).toBeInTheDocument();
  });

  it('★★ submits the address to the same flow it opened', async () => {
    show();
    await userEvent.type(await screen.findByTestId('recover-email'), 'maya@avivco.il');
    await userEvent.click(screen.getByTestId('recover-submit'));

    await waitFor(() =>
      expect(submitStage).toHaveBeenCalledWith({ uid_field: 'maya@avivco.il' }, FLOW),
    );
  });

  it('⚠⚠ says the same thing whether or not the account exists', async () => {
    /*
     * ════════════════════════════════════════════════════════════════════════
     * A RECOVERY FORM THAT SAYS "NO SUCH ACCOUNT" IS AN ADDRESS ORACLE
     * ════════════════════════════════════════════════════════════════════════
     * Anyone could walk a list of addresses through it and learn which ones
     * have accounts here. The stage itself does not distinguish, and neither
     * does this screen.
     */
    show();
    await userEvent.type(await screen.findByTestId('recover-email'), 'nobody@example.com');
    await userEvent.click(screen.getByTestId('recover-submit'));

    const done = await screen.findByTestId('recover-sent');
    expect(done.textContent).toMatch(/nobody@example\.com/);
    expect(done.textContent).not.toMatch(/no such|not found|unknown|does not exist/i);
  });

  it('★ shows what the stage said when it refuses', async () => {
    submitStage.mockResolvedValue({
      ok: true,
      step: identifyOnly({
        uid_field: [{ string: 'Enter a valid email address.', code: 'invalid' }],
      }),
    });

    show();
    await userEvent.type(await screen.findByTestId('recover-email'), 'not-an-email');
    await userEvent.click(screen.getByTestId('recover-submit'));

    expect(await screen.findByRole('alert')).toHaveTextContent(/valid email/i);
    expect(screen.queryByTestId('recover-sent')).toBeNull();
  });

  it('⚠ a transport failure keeps what was typed', async () => {
    /*
     * `ok: false` is not a refusal — it is the network. Moving somebody to a
     * confirmation screen would claim mail was sent when nothing was, and
     * clearing the field makes them type it again for a problem a second press
     * often fixes.
     */
    submitStage.mockResolvedValue({ ok: false });

    show();
    const field = await screen.findByTestId('recover-email');
    await userEvent.type(field, 'maya@avivco.il');
    await userEvent.click(screen.getByTestId('recover-submit'));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByTestId('recover-sent')).toBeNull();
    expect(field).toHaveValue('maya@avivco.il');
  });

  it('★ offers the way back to sign-in', async () => {
    show();
    expect(await screen.findByTestId('recover-back')).toHaveAttribute('href', '/v2/en/sign-in');
  });
});
