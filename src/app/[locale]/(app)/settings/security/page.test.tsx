import { render, screen, within } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import security from '@/i18n/messages/en/security.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'security') =>
    createTranslator({ locale: 'en', messages: { security }, namespace }),
}));
vi.mock('@/shell/SettingsSection', () => ({
  SettingsSection: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/features/security/MfaPolicy', () => ({
  MfaPolicy: () => <div data-testid="mfa-policy" />,
}));
vi.mock('@/features/security/SessionList', () => ({
  SessionList: () => <div data-testid="sessions" />,
}));
vi.mock('@/features/security/SecuritySections', () => ({
  AuditSection: () => <div data-testid="audit" />,
  LoginHistory: () => <div data-testid="logins" />,
}));
vi.mock('@/features/security/load-security', () => ({
  loadSecurity: async () => ({
    sessions: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    sessionsAvailable: true,
    logins: [],
    loginsAvailable: true,
    tenant: { mfaRequiredForAdmins: true, mfaRequiredForAllUsers: false },
    audit: [],
    auditAvailable: true,
    facets: [],
    facetsTruncated: false,
  }),
}));

import Page from './page';

describe('★ 16 — 02’s cards, in 02’s order', () => {
  it('sign-in policy beside the devices; the audit after; sign-ins last', async () => {
    const { container } = render(await Page());
    const order = [...container.querySelectorAll('section[data-testid]')].map((s) =>
      s.getAttribute('data-testid'),
    );
    expect(order).toEqual(['section-mfa', 'section-sessions', 'section-audit', 'section-logins']);
  });

  it('Google and the session rows are drawn, as "—", with why on their titles', async () => {
    render(await Page());
    const mfa = screen.getByTestId('section-mfa');
    const google = within(mfa).getByText('Sign in with Google').closest('[title]');
    const session = within(mfa).getByText('Sign out after inactivity').closest('[title]');
    expect(google).toHaveTextContent('—');
    expect(session).toHaveTextContent('—');
    // Never "7 days": the platform's session length is not an inactivity timeout.
    expect(session).toHaveAttribute('title', expect.stringMatching(/not an inactivity timeout/));
    expect(mfa).not.toHaveTextContent(/days/);
  });
});

describe('★ 16 — the devices card’s head counts them', () => {
  it('"3 devices", from the list it heads', async () => {
    render(await Page());
    expect(screen.getByTestId('sessions-count')).toHaveTextContent(/^3 devices$/);
  });
});
