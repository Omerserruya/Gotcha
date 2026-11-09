import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MfaGate as Gate } from '@/api/contracts/mfa';
import heNavigation from '@/i18n/messages/he/navigation.json';
import heSecurity from '@/i18n/messages/he/security.json';
import navigation from '@/i18n/messages/en/navigation.json';
import security from '@/i18n/messages/en/security.json';

/**
 * ★★ The MFA gate (legacy MfaEnrollmentGate): Authentik's two setup flows,
 * framed; re-checked every 3s, on focus and when the frame moves on; released
 * only by the server's mustEnroll: false; never by a failed check.
 * ⚠ The re-check is mocked: nothing here reads or enrols anything.
 */
const checkMfaGate = vi.hoisted(() => vi.fn());
vi.mock('./mfa-actions', () => ({ checkMfaGate }));
const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
const signOut = vi.hoisted(() => vi.fn());
vi.mock('@/auth/sign-out', () => ({ signOut }));

import { MFA_POLL_MS, MFA_SETTLE_MS, MfaGate } from './MfaGate';

const ORIGIN = 'https://auth.example.test';
const gate = (over: Partial<Gate> = {}): Gate => ({
  required: true,
  reason: 'system_admin',
  enrolled: false,
  hasAuthenticator: false,
  hasRecovery: false,
  mustEnroll: true,
  identityAvailable: true,
  ...over,
});
const show = (initial = gate(), locale: 'en' | 'he' = 'en') =>
  render(
    <NextIntlClientProvider
      locale={locale}
      messages={
        locale === 'en'
          ? { security, navigation }
          : { security: heSecurity, navigation: heNavigation }
      }
    >
      <MfaGate initial={initial} authOrigin={ORIGIN} />
    </NextIntlClientProvider>,
  );
const frame = () => screen.getByTestId('mfa-flow') as HTMLIFrameElement;
const tick = async (ms: number) => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  checkMfaGate.mockReset();
  refresh.mockReset();
  signOut.mockReset();
});
afterEach(() => vi.useRealTimers());

describe('★★ the steps: the authenticator, chained into recovery codes', () => {
  it('step 1: the authenticator flow, from the identity provider, chaining by a RELATIVE next', () => {
    show();
    const src = new URL(frame().src);
    expect(src.origin).toBe(ORIGIN);
    expect(src.pathname).toBe('/if/flow/default-authenticator-totp-setup/');
    expect(src.searchParams.get('next')).toBe('/if/flow/default-authenticator-static-setup/');
    expect(screen.getByTestId('mfa-step-totp')).toHaveAttribute('data-state', 'current');
    expect(screen.getByTestId('mfa-step-recovery')).toHaveAttribute('data-state', 'todo');
  });

  it('step 2: an authenticator in, the recovery-codes flow, with no next', () => {
    show(gate({ hasAuthenticator: true }));
    const src = new URL(frame().src);
    expect(src.pathname).toBe('/if/flow/default-authenticator-static-setup/');
    expect(src.searchParams.has('next')).toBe(false);
    expect(screen.getByTestId('mfa-step-totp')).toHaveAttribute('data-state', 'done');
    expect(screen.getByTestId('mfa-step-recovery')).toHaveAttribute('data-state', 'current');
  });

  it.each([
    ['system_admin', 'Two-step sign-in is required for platform administrators.'],
    ['tenant_admins', 'Your workspace requires admins to use two-step sign-in.'],
    ['all_users', 'Your workspace requires two-step sign-in for everyone.'],
    [null, 'To continue, set up two-step sign-in.'],
  ] as const)('the reason %s, said', (reason, words) => {
    show(gate({ reason }));
    expect(screen.getByTestId('mfa-gate-reason')).toHaveTextContent(words);
  });

  it('in Hebrew: the Hebrew title and reason', () => {
    show(gate(), 'he');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('הגדרת כניסה דו־שלבית');
    expect(screen.getByTestId('mfa-gate-reason')).toHaveTextContent(
      'כניסה דו־שלבית היא חובה למנהלי הפלטפורמה.',
    );
  });
});

describe('★★ released only by the server', () => {
  it('the poll: still owed, the gate stays; enrolled, the page refreshes (the layout draws the product)', async () => {
    checkMfaGate.mockResolvedValueOnce(gate({ hasAuthenticator: true }));
    show();
    await tick(MFA_POLL_MS);
    expect(checkMfaGate).toHaveBeenCalledTimes(1);
    // Step 1 done: the stepper and the frame moved on.
    expect(new URL(frame().src).pathname).toBe('/if/flow/default-authenticator-static-setup/');
    expect(refresh).not.toHaveBeenCalled();
    checkMfaGate.mockResolvedValue(gate({ mustEnroll: false, enrolled: true }));
    await tick(MFA_POLL_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
    await tick(MFA_POLL_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('★★ a failed check (null, or thrown) never releases it', async () => {
    checkMfaGate.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('offline'));
    show();
    await tick(MFA_POLL_MS);
    await tick(MFA_POLL_MS);
    expect(checkMfaGate).toHaveBeenCalledTimes(2);
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByTestId('mfa-gate')).toBeInTheDocument();
  });

  it('the frame’s first load is its own; a later one masks and checks', async () => {
    checkMfaGate.mockResolvedValue(gate());
    show();
    fireEvent.load(frame());
    expect(screen.queryByTestId('mfa-verifying')).toBeNull();
    fireEvent.load(frame());
    expect(screen.getByTestId('mfa-verifying')).toBeInTheDocument();
    await tick(MFA_SETTLE_MS);
    expect(checkMfaGate).toHaveBeenCalledTimes(1);
  });

  it('focus checks; "I’ve finished" checks; "Restart" reloads the step; sign out signs out', async () => {
    checkMfaGate.mockResolvedValue(gate());
    show();
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    expect(checkMfaGate).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('mfa-finished'));
    await tick(0);
    expect(checkMfaGate).toHaveBeenCalledTimes(2);
    const before = frame().src;
    fireEvent.click(screen.getByTestId('mfa-restart'));
    expect(frame().src).not.toBe(before);
    fireEvent.click(screen.getByTestId('mfa-sign-out'));
    expect(signOut).toHaveBeenCalledTimes(1);
  });
});
