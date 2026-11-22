import { render, screen } from '@testing-library/react';
import type React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** ★★ Connect: two-step sign-in owed, the enrolment step instead (supervisor, 2026-11-09). */
const owed = vi.hoisted(() => ({ value: false }));
vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  redirect: () => {
    throw new Error('NEXT_REDIRECT');
  },
}));
vi.mock('@/api/client/signed-out', () => ({ signInHere: async () => '/api/auth/login' }));
vi.mock('@/auth/session-store', () => ({ activeSession: async () => ({ sid: 's' }) }));
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
  mfaGateScreen: async () => (owed.value ? <p data-testid="mfa-gate" /> : null),
}));

const { default: ConnectLayout } = await import('./layout');
const open = () =>
  ConnectLayout({
    children: <p data-testid="connect">connect</p>,
    params: Promise.resolve({ locale: 'he' }),
  });

beforeEach(() => {
  owed.value = false;
});

describe('★★ connect and two-step sign-in', () => {
  it('owed: the gate, not the page', async () => {
    owed.value = true;
    render(await open());
    expect(screen.getByTestId('mfa-gate')).toBeInTheDocument();
    expect(screen.queryByTestId('connect')).toBeNull();
  });

  it('★★ the Terms a Google sign-in owes come first, before two-step (2026-11-22)', async () => {
    terms.owed = true;
    owed.value = true;
    try {
      render(await open());
      expect(screen.getByTestId('terms-gate')).toBeInTheDocument();
      expect(screen.queryByTestId('mfa-gate')).toBeNull();
      expect(screen.queryByTestId('connect')).toBeNull();
    } finally {
      terms.owed = false;
    }
  });

  it('not owed: the page', async () => {
    render(await open());
    expect(screen.getByTestId('connect')).toBeInTheDocument();
  });
});
