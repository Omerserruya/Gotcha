import { render, screen, within } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import security from '@/i18n/messages/en/security.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'security') =>
    createTranslator({ locale: 'en', messages: { security }, namespace }),
}));
vi.mock('@/shell/SettingsSection', () => ({
  SettingsSection: ({ children, fill }: { children: React.ReactNode; fill?: boolean }) => (
    <div data-testid="settings-section" data-fill={fill ? 'yes' : 'no'}>
      {children}
    </div>
  ),
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

/* The connected-accounts card (Google sign-in, 2026-11-22). */
const google = vi.hoisted(() => ({ card: { kind: 'off' } as Record<string, unknown> }));
vi.mock('@/features/security/load-google', () => ({
  loadGoogleConnection: async () => google.card,
}));
vi.mock('@/features/security/GoogleConnection', () => ({
  GoogleConnection: ({
    marker,
    connectGo,
  }: {
    marker: string | null;
    connectGo: React.ReactNode;
  }) => (
    <div data-testid="google-connection" data-marker={marker ?? 'none'}>
      {connectGo}
    </div>
  ),
}));
vi.mock('@/shell/account/ConnectGoogleButton', () => ({
  ConnectGoogleButton: () => <button type="button" data-testid="connect-go" />,
}));

import Page from './page';

const props = (search: Record<string, string> = {}) => ({ searchParams: Promise.resolve(search) });

describe('★ 16 - 02’s cards, in 02’s order', () => {
  it('sign-in policy beside the devices; the audit after; sign-ins last', async () => {
    const { container } = render(await Page(props()));
    const order = [...container.querySelectorAll('section[data-testid]')].map((s) =>
      s.getAttribute('data-testid'),
    );
    expect(order).toEqual(['section-mfa', 'section-sessions', 'section-audit', 'section-logins']);
  });

  it('Google and the session rows are drawn, as "-", with why on their titles', async () => {
    render(await Page(props()));
    const mfa = screen.getByTestId('section-mfa');
    const google = within(mfa).getByText('Sign in with Google').closest('[title]');
    const session = within(mfa).getByText('Sign out after inactivity').closest('[title]');
    expect(google).toHaveTextContent('-');
    expect(session).toHaveTextContent('-');
    // Never "7 days": the platform's session length is not an inactivity timeout.
    expect(session).toHaveAttribute('title', expect.stringMatching(/not an inactivity timeout/));
    expect(mfa).not.toHaveTextContent(/days/);
  });
});

describe('★ 16 - the devices card’s head counts them', () => {
  it('"3 devices", from the list it heads', async () => {
    render(await Page(props()));
    expect(screen.getByTestId('sessions-count')).toHaveTextContent(/^3 devices$/);
  });
});

describe('★ 16 - the audit runs to the frame’s bottom', () => {
  it('the section fills, so the audit card can', async () => {
    render(await Page(props()));
    expect(screen.getByTestId('settings-section')).toHaveAttribute('data-fill', 'yes');
  });
});

describe('★★ 16 - connected accounts (Google sign-in, 2026-11-22)', () => {
  it('★ Google off in this environment: no card at all', async () => {
    google.card = { kind: 'off' };
    render(await Page(props()));
    expect(screen.queryByTestId('section-google')).toBeNull();
  });

  it('★★ on: its own card under the top row, before the audit, with the shell’s connect button', async () => {
    google.card = { kind: 'read', google: { available: true, connected: false } };
    const { container } = render(await Page(props()));
    const order = [...container.querySelectorAll('section[data-testid]')].map((s) =>
      s.getAttribute('data-testid'),
    );
    expect(order).toEqual([
      'section-mfa',
      'section-sessions',
      'section-google',
      'section-audit',
      'section-logins',
    ]);
    const card = screen.getByTestId('section-google');
    expect(within(card).getByRole('heading', { level: 2 })).toHaveTextContent('Connected accounts');
    expect(within(card).getByTestId('connect-go')).toBeInTheDocument();
  });

  it('★ the callback’s marker reaches the card; one outside the list does not', async () => {
    google.card = { kind: 'read', google: { available: true, connected: true } };
    render(await Page(props({ google: 'connected' })));
    expect(screen.getByTestId('google-connection')).toHaveAttribute('data-marker', 'connected');
  });

  it('⚠ an unknown marker is none', async () => {
    google.card = { kind: 'unread' };
    render(await Page(props({ google: 'pwned' })));
    expect(screen.getByTestId('google-connection')).toHaveAttribute('data-marker', 'none');
  });
});
