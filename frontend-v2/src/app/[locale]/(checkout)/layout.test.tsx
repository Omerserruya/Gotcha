import { render, screen } from '@testing-library/react';
import type React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ★★ Checkout: two-step sign-in owed, the enrolment step instead (supervisor,
 * 2026-11-09). Checkout opens signed out too: no session, nothing asked.
 */
const owed = vi.hoisted(() => ({ value: false }));
const session = vi.hoisted(() => ({ value: { sid: 's' } as object | null }));
const asked = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('@/auth/session-store', () => ({ activeSession: async () => session.value }));
vi.mock('next-intl', () => ({
  NextIntlClientProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/i18n/load-messages', () => ({ loadMessages: async () => ({}) }));
vi.mock('@/support/load-support', () => ({ loadSupport: async () => null }));
vi.mock('@/features/support/SupportBanner', () => ({
  WithSupportBanner: ({ children }: { children: React.ReactNode }) => children,
}));
/* The Terms gate (Google sign-in, 2026-11-22): owed only when `terms.owed` says so. */
const terms = vi.hoisted(() => ({ owed: false }));
vi.mock('@/shell/terms/terms-gate-screen', () => ({
  termsGateScreen: async () => (terms.owed ? <p data-testid="terms-gate" /> : null),
}));
vi.mock('@/shell/mfa/mfa-gate-screen', () => ({
  mfaGateScreen: async () => {
    asked();
    return owed.value ? <p data-testid="mfa-gate" /> : null;
  },
}));

const { default: CheckoutLayout } = await import('./layout');
const open = () =>
  CheckoutLayout({
    children: <p data-testid="checkout">checkout</p>,
    params: Promise.resolve({ locale: 'he' }),
  });

beforeEach(() => {
  owed.value = false;
  session.value = { sid: 's' };
  asked.mockReset();
});

describe('★★ checkout and two-step sign-in', () => {
  it('signed in, owed: the gate, not checkout', async () => {
    owed.value = true;
    render(await open());
    expect(screen.getByTestId('mfa-gate')).toBeInTheDocument();
    expect(screen.queryByTestId('checkout')).toBeNull();
  });

  it('★★ the Terms a Google sign-in owes come first, before two-step (2026-11-22)', async () => {
    terms.owed = true;
    owed.value = true;
    try {
      render(await open());
      expect(screen.getByTestId('terms-gate')).toBeInTheDocument();
      expect(screen.queryByTestId('mfa-gate')).toBeNull();
      expect(screen.queryByTestId('checkout')).toBeNull();
    } finally {
      terms.owed = false;
    }
  });

  it('★ signed out: no Terms gate either - there is no sign-in to owe them', async () => {
    session.value = null;
    terms.owed = true;
    try {
      render(await open());
      expect(screen.getByTestId('checkout')).toBeInTheDocument();
    } finally {
      terms.owed = false;
    }
  });

  it('signed in, not owed: checkout', async () => {
    render(await open());
    expect(screen.getByTestId('checkout')).toBeInTheDocument();
  });

  it('★ signed out: checkout, and the gate is not even asked', async () => {
    session.value = null;
    owed.value = true;
    render(await open());
    expect(screen.getByTestId('checkout')).toBeInTheDocument();
    expect(asked).not.toHaveBeenCalled();
  });
});
