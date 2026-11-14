import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { integrationSchema } from '@/api/contracts/integrations';
import capabilitiesEn from '@/i18n/messages/en/capabilities.json';
import onboardingEn from '@/i18n/messages/en/onboarding.json';

/** Step 2's launcher. The server actions are mocked: nothing is started anywhere. */
const startOAuth = vi.hoisted(() => vi.fn());
const startWooOAuth = vi.hoisted(() => vi.fn());
const startShopifyInstall = vi.hoisted(() => vi.fn());
vi.mock('@/features/capabilities/connect-actions', () => ({ startOAuth, startWooOAuth }));
vi.mock('@/features/capabilities/shopify-actions', () => ({ startShopifyInstall }));
vi.mock('@/features/capabilities/ConnectForm', () => ({
  ConnectForm: ({ slug, label }: { slug: string; label: string }) => (
    <span data-testid={`form-${slug}`}>{label}</span>
  ),
}));

import { SystemsConnect } from './SystemsConnect';

const row = (slug: string, name: string, authSchema: object) =>
  integrationSchema.parse({ id: `i-${slug}`, slug, name, authType: 'OAUTH2', authSchema });
const woo = row('woocommerce', 'WooCommerce', { oauth: false, fields: [] });
const shopify = row('shopify', 'Shopify', { oauth: true, fields: [] });
const hubspot = row('hubspot', 'HubSpot', { oauth: true, fields: [] });
const returngo = row('returngo', 'ReturnGO', {
  oauth: false,
  fields: [{ key: 'apiKey', type: 'password', label: 'API key', required: true }],
});

const assign = vi.fn();
beforeEach(() => {
  for (const f of [startOAuth, startWooOAuth, startShopifyInstall, assign]) f.mockReset();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, assign },
  });
});

const show = (props: Partial<Parameters<typeof SystemsConnect>[0]> & { integration: typeof woo }) =>
  render(
    <NextIntlClientProvider
      locale="en"
      messages={{ onboarding: onboardingEn, capabilities: capabilitiesEn }}
    >
      <SystemsConnect
        name={props.integration.name}
        shopify={{ mode: 'listing', helpUrl: null }}
        store={null}
        variant="hero"
        {...props}
      />
    </NextIntlClientProvider>,
  );

describe('★★ every start from step 2 asks to come back to step 2 (flow=onboarding_systems)', () => {
  it('★★ WooCommerce, one click: the scanned store, shown beside the button, sent with the flow', async () => {
    startWooOAuth.mockResolvedValue({
      ok: true,
      url: 'https://avivco.il/wc-auth/v1/authorize?x=1',
    });
    show({ integration: woo, store: 'https://www.avivco.il/shop' });
    expect(screen.getByTestId('systems-woo-store')).toHaveTextContent('Store: avivco.il');
    expect(screen.queryByTestId('systems-woo-address')).toBeNull();
    await userEvent.click(screen.getByTestId('systems-start-woocommerce'));
    await waitFor(() =>
      expect(startWooOAuth).toHaveBeenCalledWith('avivco.il', 'onboarding_systems'),
    );
    expect(assign).toHaveBeenCalledWith('https://avivco.il/wc-auth/v1/authorize?x=1');
  });

  it('★ WooCommerce at a different address: the field opens, and what is typed is sent', async () => {
    startWooOAuth.mockResolvedValue({ ok: true, url: 'https://shop.example.com/wc-auth' });
    show({ integration: woo, store: 'avivco.il' });
    await userEvent.click(screen.getByTestId('systems-woo-change'));
    const field = screen.getByTestId('systems-woo-address');
    await userEvent.clear(field);
    await userEvent.type(field, 'shop.example.com');
    await userEvent.click(screen.getByTestId('systems-start-woocommerce'));
    await waitFor(() =>
      expect(startWooOAuth).toHaveBeenCalledWith('shop.example.com', 'onboarding_systems'),
    );
  });

  it('★★ WooCommerce with no store known: the field first, the button waits for an address', () => {
    show({ integration: woo });
    expect(screen.getByTestId('systems-woo-address')).toHaveValue('');
    expect(screen.getByTestId('systems-start-woocommerce')).toBeDisabled();
  });

  it('★★ a store that can’t be reached: said with what to do, the field open to fix it', async () => {
    startWooOAuth.mockResolvedValue({ ok: false, reason: 'invalid_store' });
    show({ integration: woo, store: 'avivco.il' });
    await userEvent.click(screen.getByTestId('systems-start-woocommerce'));
    expect(await screen.findByTestId('systems-start-problem-woocommerce')).toHaveTextContent(
      "We couldn't reach a store at that address. Check it and try again.",
    );
    expect(screen.getByTestId('systems-woo-address')).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it('★★ Shopify: the install, with the flow', async () => {
    startShopifyInstall.mockResolvedValue({ ok: true, url: 'https://apps.shopify.com/gotcha' });
    show({ integration: shopify });
    await userEvent.click(screen.getByTestId('systems-start-shopify'));
    await waitFor(() => expect(startShopifyInstall).toHaveBeenCalledWith('onboarding_systems'));
    expect(assign).toHaveBeenCalledWith('https://apps.shopify.com/gotcha');
  });

  it('★★ split billing: GOTCHA Core not active - said, and no button that would 402', () => {
    show({
      integration: shopify,
      shopify: { mode: 'listing', helpUrl: null, connectAllowed: false },
    });
    expect(screen.getByTestId('systems-shopify-core-first')).toHaveTextContent(
      'Connecting a Shopify store needs an active GOTCHA Core plan first.',
    );
    expect(screen.queryByTestId('systems-start-shopify')).toBeNull();
  });

  it.each([true, null])('Core allowed (%s) or not said: the button stays', (connectAllowed) => {
    show({ integration: shopify, shopify: { mode: 'listing', helpUrl: null, connectAllowed } });
    expect(screen.getByTestId('systems-start-shopify')).toBeInTheDocument();
  });

  it('the server refuses with core_plan_required: said in words', async () => {
    startShopifyInstall.mockResolvedValue({ ok: false, reason: 'core_plan_required' });
    show({ integration: shopify });
    await userEvent.click(screen.getByTestId('systems-start-shopify'));
    expect(await screen.findByTestId('systems-start-problem-shopify')).toHaveTextContent(
      'Connecting Shopify needs an active GOTCHA Core plan first. Nothing was connected.',
    );
  });

  it('★ Shopify not listed yet: a sentence, never a dead button', () => {
    show({ integration: shopify, shopify: { mode: 'not_published', helpUrl: null } });
    expect(screen.getByTestId('systems-shopify-not-here')).toHaveTextContent(
      'The Shopify install starts in Shopify',
    );
    expect(screen.queryByTestId('systems-start-shopify')).toBeNull();
  });

  it('★★ Shopify reconnect re-authorises at Shopify, with the flow', async () => {
    startOAuth.mockResolvedValue({ ok: true, url: 'https://x.myshopify.com/admin/oauth' });
    show({ integration: shopify, reconnect: true });
    expect(screen.getByTestId('systems-start-shopify')).toHaveTextContent('Reconnect Shopify');
    await userEvent.click(screen.getByTestId('systems-start-shopify'));
    await waitFor(() =>
      expect(startOAuth).toHaveBeenCalledWith('shopify', undefined, 'onboarding_systems'),
    );
  });

  it('★★ an OAuth system, with the flow; a failed start says the next step', async () => {
    startOAuth.mockResolvedValue({ ok: false, reason: 'not_configured' });
    show({ integration: hubspot, variant: 'row' });
    await userEvent.click(screen.getByTestId('systems-start-hubspot'));
    await waitFor(() =>
      expect(startOAuth).toHaveBeenCalledWith('hubspot', undefined, 'onboarding_systems'),
    );
    expect(await screen.findByTestId('systems-start-problem-hubspot')).toHaveTextContent(
      'connect it later in Settings',
    );
  });

  it('a key form: in the card at once; in a row, behind its button', async () => {
    const { unmount } = show({ integration: returngo });
    expect(screen.getByTestId('form-returngo')).toHaveTextContent('Connect ReturnGO');
    unmount();
    show({ integration: returngo, variant: 'row' });
    expect(screen.queryByTestId('form-returngo')).toBeNull();
    await userEvent.click(screen.getByTestId('systems-start-returngo'));
    expect(screen.getByTestId('form-returngo')).toBeInTheDocument();
  });
});
