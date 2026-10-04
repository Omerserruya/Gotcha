import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import messages from '@/i18n/messages/en/capabilities.json';

const replace = vi.hoisted(() => vi.fn());
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ replace }),
  usePathname: () => '/studio/capabilities',
}));

import { OAUTH_FAILURES, oauthFailure, oauthHere } from './oauth';
import { OAuthLanding } from './OAuthLanding';

beforeEach(() => {
  replace.mockReset();
});

describe('★ which systems come back here (backend 381a5d1b)', () => {
  it.each([
    ['hubspot', false, true],
    ['salesforce', false, true],
    ['monday', false, true],
    // Shopify re-authorises the store it has; a new one is installed from Shopify.
    ['shopify', true, true],
    ['shopify', false, false],
    // Live since backend e7523379.
    ['stripe', false, true],
    ['zoho_crm', false, true],
    ['google_calendar', true, true],
    ['calendly', false, true],
    // No redesign flow yet.
    ['wix', false, false],
    ['square', false, false],
  ] as const)('%s (connected: %s) → %s', (slug, connected, here) => {
    expect(oauthHere(slug, connected)).toBe(here);
  });
});

describe('★★ the way back: said once, then the query is cleaned', () => {
  const land = (outcome: Parameters<typeof OAuthLanding>[0]['outcome']) =>
    render(
      <NextIntlClientProvider locale="en" messages={{ capabilities: messages }}>
        <OAuthLanding slug="hubspot" name="HubSpot" outcome={outcome} />
      </NextIntlClientProvider>,
    );

  it('connected: green, and the URL keeps only the system', () => {
    land('connected');
    expect(screen.getByTestId('oauth-landing')).toHaveTextContent('HubSpot is connected.');
    expect(screen.getByTestId('oauth-landing')).toHaveAttribute('data-outcome', 'ok');
    expect(replace).toHaveBeenCalledWith(
      { pathname: '/studio/capabilities', query: { system: 'hubspot' } },
      { scroll: false },
    );
  });

  it('denied is the person cancelling, not a failure of ours', () => {
    land('denied');
    expect(screen.getByTestId('oauth-landing')).toHaveTextContent(
      'You cancelled at HubSpot — nothing was connected.',
    );
  });

  it.each([...OAUTH_FAILURES, 'other' as const])(
    '%s has its own sentence, never the code',
    (code) => {
      land(code);
      const text = screen.getByTestId('oauth-landing').textContent ?? '';
      expect(text.length).toBeGreaterThan(10);
      expect(text).not.toContain(code === 'other' ? 'capabilities.' : code);
      expect(screen.getByTestId('oauth-landing')).toHaveAttribute('data-outcome', 'problem');
    },
  );

  it('an unknown code is "other"; none is nothing to say', () => {
    expect(oauthFailure('weird')).toBe('other');
    expect(oauthFailure('denied')).toBe('denied');
    expect(oauthFailure(undefined)).toBeNull();
  });
});

describe('★★ the sentence outlives the tidied URL', () => {
  const tree = (outcome: Parameters<typeof OAuthLanding>[0]['outcome']) => (
    <NextIntlClientProvider locale="en" messages={{ capabilities: messages }}>
      <OAuthLanding slug="hubspot" name="HubSpot" outcome={outcome} />
    </NextIntlClientProvider>
  );

  it('after the replace re-renders without the query, it is still there — until closed', async () => {
    const { rerender } = render(tree('denied'));
    // What the page renders once the URL holds only ?system=hubspot.
    rerender(tree(null));
    expect(screen.getByTestId('oauth-landing')).toHaveTextContent('You cancelled at HubSpot');
    await userEvent.click(screen.getByTestId('oauth-landing-close'));
    expect(screen.queryByTestId('oauth-landing')).toBeNull();
  });

  it('no way back: nothing said, and the URL left alone', () => {
    render(tree(null));
    expect(screen.queryByTestId('oauth-landing')).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });
});
