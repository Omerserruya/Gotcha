import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import capabilities from '@/i18n/messages/en/capabilities.json';

const replace = vi.hoisted(() => vi.fn());
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ replace }),
  usePathname: () => '/studio/capabilities',
}));
vi.mock('./WooFirewallHelp', () => ({
  WooFirewallHelp: () => <div data-testid="woo-firewall-help" />,
}));

import { OAuthLanding } from './OAuthLanding';

/** Studio's way back from the store, when a firewall answered (2026-11-15). */
const show = (slug: string, outcome: Parameters<typeof OAuthLanding>[0]['outcome']) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ capabilities }}>
      <OAuthLanding slug={slug} name="WooCommerce" outcome={outcome} />
    </NextIntlClientProvider>,
  );

describe('★★ a firewall answered, not the store', () => {
  it('★★ the sentence, and the help under it - kept here, since the address is tidied', () => {
    show('woocommerce', 'store_firewall_challenge');
    expect(screen.getByTestId('oauth-landing')).toHaveTextContent(
      capabilities.landing.error.store_firewall_challenge.replace('{name}', 'WooCommerce'),
    );
    expect(screen.getByTestId('woo-firewall-help')).toBeInTheDocument();
    // The address is tidied (a router replace); the help is this component's, so it stays.
    expect(replace).toHaveBeenCalled();
  });

  it('★ any other failure, or another system: no firewall help', () => {
    show('woocommerce', 'denied');
    expect(screen.queryByTestId('woo-firewall-help')).toBeNull();
  });
});
