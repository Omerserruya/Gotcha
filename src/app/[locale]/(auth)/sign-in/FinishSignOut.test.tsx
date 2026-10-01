import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runInvalidationFlow = vi.hoisted(() => vi.fn());
vi.mock('@/api/client/flow-executor', () => ({ runInvalidationFlow }));

const { FinishSignOut } = await import('./FinishSignOut');

const END_SESSION =
  'https://auth-dev.gotcha.co.il/application/o/gotcha/end-session/?id_token_hint=x';
const SIGNED_OUT = '/v2/en/sign-in';
const replace = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'location', { value: { replace }, writable: true });
});

const show = () => render(<FinishSignOut endSessionUrl={END_SESSION} signedOutUrl={SIGNED_OUT} />);

describe('⚠⚠ signing out without the provider drawing its completion page', () => {
  it('★★ lands on our own screen once the flow has run', async () => {
    runInvalidationFlow.mockResolvedValue(true);
    show();
    await waitFor(() => expect(replace).toHaveBeenCalledWith(SIGNED_OUT));
  });

  it('⚠⚠ and NAVIGATES TO END-SESSION when it cannot confirm the flow ran', async () => {
    /*
     * ════════════════════════════════════════════════════════════════════════
     * THE ONLY OUTCOME WORSE THAN THE PAGE IS A CLEAN SCREEN AND A LIVE SESSION
     * ════════════════════════════════════════════════════════════════════════
     * This app shipped exactly that today: `82e0a2c` returned a local redirect,
     * never called `end-session`, and `authentik_session` survived — a fresh
     * authorization then issued a code with no credentials entered.
     *
     * ★ So an unconfirmed flow does NOT land quietly on our sign-in. It goes
     *   to the provider, which shows its page and genuinely ends the session —
     *   today's behaviour, which is the right thing to fall back to.
     */
    runInvalidationFlow.mockResolvedValue(false);
    show();
    await waitFor(() => expect(replace).toHaveBeenCalledWith(END_SESSION));
    expect(replace).not.toHaveBeenCalledWith(SIGNED_OUT);
  });

  it('⚠⚠ runs the flow against the URL it was given, not a composed one', async () => {
    runInvalidationFlow.mockResolvedValue(true);
    show();
    await waitFor(() => expect(runInvalidationFlow).toHaveBeenCalledWith(END_SESSION));
  });

  it('★ draws nothing — the session is already gone by the time anything renders', async () => {
    runInvalidationFlow.mockResolvedValue(true);
    show();
    const marker = screen.getByTestId('finish-sign-out');
    expect(marker).not.toBeVisible();
    expect(marker.textContent).toBe('');
  });
});
