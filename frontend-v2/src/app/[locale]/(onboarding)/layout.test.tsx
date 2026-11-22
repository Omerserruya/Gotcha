import { render, screen } from '@testing-library/react';
import type React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ★★ The onboarding layout's gate, and `?preview=1` through it (Omer,
 * 2026-10-07): a LIVE workspace's admin may walk onboarding when asked for
 * it; anyone else live is sent Home, preview or not.
 */
const gate = vi.hoisted(() => vi.fn());
const returnTo = vi.hoisted(() => ({ value: null as string | null }));
const sent = vi.hoisted(() => ({ home: vi.fn(), signIn: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  headers: async () => new Headers(returnTo.value ? { 'x-gotcha-return-to': returnTo.value } : {}),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    sent.signIn(to);
    throw new Error('NEXT_REDIRECT');
  },
}));
vi.mock('@/api/client/signed-out', () => ({ signInHere: async () => '/api/auth/login' }));
vi.mock('@/auth/session-store', () => ({ activeSession: async () => ({ sid: 's' }) }));
vi.mock('next-intl', () => ({
  NextIntlClientProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/i18n/load-messages', () => ({ loadMessages: async () => ({}) }));
vi.mock('@/i18n/navigation', () => ({
  redirect: (to: unknown) => {
    sent.home(to);
    throw new Error('NEXT_REDIRECT');
  },
}));
vi.mock('@/shell/load-workspace-gate', () => ({
  readWorkspaceGate: gate,
  paymentPath: async () => '/checkout',
}));
/* Support mode: none unless a test opens one; the banner is a marker here. */
const support = vi.hoisted(() => ({ value: null as Record<string, unknown> | null }));
vi.mock('@/support/load-support', () => ({ loadSupport: async () => support.value }));
vi.mock('@/features/support/SupportBanner', async () => {
  const { useSupport } = await import('@/support/support-context');
  return {
    WithSupportBanner: ({ children }: { children: React.ReactNode }) => (
      <>
        {useSupport().session ? <p data-testid="support-banner" /> : null}
        {children}
      </>
    ),
  };
});
vi.mock('@/shell/WorkspaceGate', () => ({
  WorkspaceGate: ({ route }: { route: string }) => <p data-testid="gate">{route}</p>,
}));

/* Two-step sign-in: not owed unless a test says so. */
const owed = vi.hoisted(() => ({ value: false }));
/* The Terms gate (Google sign-in, 2026-11-22): owed only when `terms.owed` says so. */
const terms = vi.hoisted(() => ({ owed: false }));
vi.mock('@/shell/terms/terms-gate-screen', () => ({
  termsGateScreen: async () => (terms.owed ? <p data-testid="terms-gate" /> : null),
}));
vi.mock('@/shell/mfa/mfa-gate-screen', () => ({
  mfaGateScreen: async () => (owed.value ? <p data-testid="mfa-gate" /> : null),
}));

const { default: OnboardingLayout } = await import('./layout');

const open = () =>
  OnboardingLayout({
    children: <p data-testid="onboarding">onboarding</p>,
    params: Promise.resolve({ locale: 'en' }),
  });

beforeEach(() => {
  owed.value = false;
  support.value = null;
  gate.mockReset();
  sent.home.mockReset();
  sent.signIn.mockReset();
  returnTo.value = null;
});

describe('★★ a live workspace and onboarding', () => {
  it('an admin, asked for a preview: onboarding draws', async () => {
    gate.mockResolvedValue({ route: 'product', setupAdmin: null, mayPreview: true });
    returnTo.value = '/en/onboarding/try?preview=1';
    render(await open());
    expect(screen.getByTestId('onboarding')).toBeInTheDocument();
    expect(sent.home).not.toHaveBeenCalled();
  });

  it('an admin, not asking: Home', async () => {
    gate.mockResolvedValue({ route: 'product', setupAdmin: null, mayPreview: true });
    returnTo.value = '/en/onboarding/try';
    await expect(open()).rejects.toThrow('NEXT_REDIRECT');
    expect(sent.home).toHaveBeenCalledWith({ href: '/home', locale: 'en' });
  });

  it('not an admin, asking: Home all the same', async () => {
    gate.mockResolvedValue({ route: 'product', setupAdmin: null, mayPreview: false });
    returnTo.value = '/en/onboarding/try?preview=1';
    await expect(open()).rejects.toThrow('NEXT_REDIRECT');
    expect(sent.home).toHaveBeenCalled();
  });

  it('a workspace being set up, its admin: onboarding, as before', async () => {
    gate.mockResolvedValue({ route: 'onboarding', setupAdmin: null, mayPreview: false });
    render(await open());
    expect(screen.getByTestId('onboarding')).toBeInTheDocument();
  });

  it('★★ support mode opens a workspace being set up here: onboarding, under the banner', async () => {
    gate.mockResolvedValue({ route: 'onboarding', setupAdmin: null, mayPreview: false });
    support.value = { tenantName: 'Aviv & Co.', reason: null, endsAt: null };
    render(await open());
    expect(screen.getByTestId('onboarding')).toBeInTheDocument();
    expect(screen.getByTestId('support-banner')).toBeInTheDocument();
  });

  it('waiting is still the gate screen, preview asked or not', async () => {
    gate.mockResolvedValue({ route: 'waiting', setupAdmin: 'Dana', mayPreview: false });
    returnTo.value = '/en/onboarding/try?preview=1';
    render(await open());
    expect(screen.getByTestId('gate')).toHaveTextContent('waiting');
    expect(screen.queryByTestId('onboarding')).toBeNull();
  });
});

describe('★★ two-step sign-in owed: the enrolment step, not onboarding (supervisor, 2026-11-09)', () => {
  it('a workspace being set up, its admin owing MFA: the gate, and no onboarding', async () => {
    gate.mockResolvedValue({ route: 'onboarding', setupAdmin: null, mayPreview: false });
    owed.value = true;
    render(await open());
    expect(screen.getByTestId('mfa-gate')).toBeInTheDocument();
    expect(screen.queryByTestId('onboarding')).toBeNull();
  });

  it('★★ the Terms a Google sign-in owes come first, before two-step (2026-11-22)', async () => {
    gate.mockResolvedValue({ route: 'onboarding', setupAdmin: null, mayPreview: false });
    terms.owed = true;
    owed.value = true;
    try {
      render(await open());
      expect(screen.getByTestId('terms-gate')).toBeInTheDocument();
      expect(screen.queryByTestId('mfa-gate')).toBeNull();
      expect(screen.queryByTestId('onboarding')).toBeNull();
    } finally {
      terms.owed = false;
    }
  });
});
