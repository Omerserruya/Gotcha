import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { capabilitySchema } from '@/api/contracts/capabilities';
import { integrationSchema } from '@/api/contracts/integrations';
import messages from '@/i18n/messages/en/capabilities.json';

const refresh = vi.hoisted(() => vi.fn());
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ refresh }) }));
/* Connecting stores real secrets: the action is a spy. */
const connectIntegration = vi.hoisted(() => vi.fn());
const startOAuth = vi.hoisted(() => vi.fn());
const startWooOAuth = vi.hoisted(() => vi.fn());
vi.mock('./connect-actions', () => ({ connectIntegration, startOAuth, startWooOAuth }));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'capabilities') =>
    createTranslator({ locale: 'en', messages: { capabilities: messages }, namespace }),
}));

import { AvailableSystem } from './AvailableSystem';
import { credentialsFor } from './connect-form';

/** Dev's catalogue rows, as `GET /api/integrations` gives them (scopes included). */
const woo = integrationSchema.parse({
  id: 'i-woo',
  slug: 'woocommerce',
  name: 'WooCommerce',
  category: 'ECOMMERCE',
  description: 'Orders and stock',
  authType: 'API_KEY',
  authSchema: {
    fields: [
      {
        key: 'storeUrl',
        type: 'url',
        label: 'Store URL',
        required: true,
        placeholder: 'https://shop.example.com',
      },
      { key: 'consumerKey', type: 'password', label: 'Consumer Key', required: true },
      { key: 'consumerSecret', type: 'password', label: 'Consumer Secret', required: true },
    ],
    required: ['storeUrl', 'consumerKey', 'consumerSecret'],
  },
  catalogTools: [
    { id: 't1', slug: 'get_order', name: 'Get Order', riskLevel: 'LOW' },
    { id: 't2', slug: 'refund_order', name: 'Refund Order', riskLevel: 'HIGH' },
  ],
  tenantConnection: null,
});
const hubspot = integrationSchema.parse({
  id: 'i-hs',
  slug: 'hubspot',
  name: 'HubSpot',
  authType: 'OAUTH2',
  authSchema: { oauth: true, fields: [], scopes: ['crm.objects.contacts.read'] },
  tenantConnection: null,
});
const airtable = integrationSchema.parse({
  id: 'i-at',
  slug: 'airtable',
  name: 'Airtable',
  authType: 'OAUTH2',
  authSchema: {
    fields: [
      {
        key: 'apiKey',
        type: 'password',
        label: 'Personal Access Token',
        required: true,
        helpText: 'with scopes: data.records:read',
      },
    ],
  },
});
/** Salesforce: OAuth, AND a field (which login host) — still connects at the provider. */
const salesforce = integrationSchema.parse({
  id: 'i-sf',
  slug: 'salesforce',
  name: 'Salesforce',
  authType: 'OAUTH2',
  authSchema: {
    oauth: true,
    fields: [
      {
        key: 'loginHost',
        type: 'select',
        label: 'Login Host',
        required: true,
        options: ['https://login.salesforce.com', 'https://test.salesforce.com'],
      },
    ],
  },
});
const custom = integrationSchema.parse({
  id: 'i-c',
  slug: 'custom_api',
  name: 'Custom API',
  authType: 'CUSTOM',
  authSchema: {},
});

const inIntl = (node: ReactNode) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ capabilities: messages }}>
      {node}
    </NextIntlClientProvider>,
  );

const assign = vi.fn();
beforeEach(() => {
  refresh.mockReset();
  connectIntegration.mockReset();
  startOAuth.mockReset();
  assign.mockReset();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, assign },
  });
});

describe('★★ authSchema, reduced to a form — scopes never leave the contract', () => {
  it('oauth is the schema’s flag, not authType: Airtable connects with a token', () => {
    expect(hubspot.authSchema).toEqual({ oauth: true, fields: [] });
    expect(airtable.authSchema.oauth).toBe(false);
    expect(airtable.authSchema.fields.map((f) => f.key)).toEqual(['apiKey']);
  });

  it('★ no scopes, no helpText — not even inside a field', () => {
    const text = JSON.stringify([hubspot, airtable, woo]);
    expect(text).not.toMatch(/scopes|crm\.objects|helpText|data\.records/);
  });

  it('absent or broken is no form, never a rejected catalogue', () => {
    expect(integrationSchema.parse({ id: 'x', slug: 'x', name: 'X' }).authSchema).toEqual({
      oauth: false,
      fields: [],
    });
    expect(
      integrationSchema.parse({
        id: 'x',
        slug: 'x',
        name: 'X',
        authSchema: { fields: [{ nope: 1 }] },
      }).authSchema.fields,
    ).toEqual([]);
  });
});

describe('★★ the tool-permissions row carries state and risk (backend 3cee674f)', () => {
  it.each([
    [{ state: 'not_provisioned', riskLevel: 'HIGH' }, 'not_provisioned', 'HIGH'],
    [{ state: 'enabled', riskLevel: 'LOW' }, 'enabled', 'LOW'],
    [{}, undefined, null],
    // An unknown value is absent, never a rejected list.
    [{ state: 'weird', riskLevel: 'EXTREME' }, undefined, null],
  ])('%o → %s / %s', (over, state, risk) => {
    const row = capabilitySchema.parse({ toolName: 'shopify.cancel_order', ...over });
    expect(row.state).toBe(state);
    expect(row.riskLevel).toBe(risk);
  });
});

describe('★ credentialsFor — exactly what the catalogue asks for', () => {
  const fields = [
    { key: 'clientId', type: 'password' as const, label: 'Client ID', required: true },
    {
      key: 'environment',
      type: 'select' as const,
      label: 'Environment',
      required: true,
      options: ['live', 'sandbox'],
    },
    { key: 'note', type: 'text' as const, label: 'Note', required: false },
  ];
  it('trimmed, extras dropped, empty optional left out', () => {
    expect(
      credentialsFor(fields, { clientId: ' abc ', environment: 'live', note: '', extra: 'x' }),
    ).toEqual({
      clientId: 'abc',
      environment: 'live',
    });
  });
  it('a required field empty, or a choice not offered: nothing', () => {
    expect(credentialsFor(fields, { clientId: '  ', environment: 'live' })).toBeNull();
    expect(credentialsFor(fields, { clientId: 'a', environment: 'prod' })).toBeNull();
  });
});

describe('★★ 10 for a system that is not connected — its own screen', () => {
  it('mark, name, what it is, what it brings with its risk', async () => {
    inIntl(await AvailableSystem({ integration: woo }));
    expect(screen.getByTestId('system-head')).toHaveTextContent('WooCommerce');
    expect(screen.getByTestId('system-line')).toHaveTextContent('Ecommerce · Orders and stock');
    expect(screen.getByTestId('system-state')).toHaveTextContent('Not connected');
    expect(screen.getByTestId('system-head').querySelector('img')?.getAttribute('src')).toMatch(
      /\/integrations\/woocommerce\.svg$/,
    );
    expect(screen.getByTestId('brings-get_order')).toHaveTextContent('Get order');
    expect(screen.getByTestId('brings-get_order')).toHaveTextContent('Low risk');
    expect(screen.getByTestId('brings-refund_order')).toHaveTextContent('High risk');
  });

  it('★★ credentials: the form, and nothing is sent without the click', async () => {
    // Any key-form system (WooCommerce itself now connects by the store's approval).
    inIntl(
      await AvailableSystem({
        integration: integrationSchema.parse({ ...woo, slug: 'bigcommerce', name: 'BigCommerce' }),
      }),
    );
    expect(screen.getByTestId('connect-consumerKey')).toHaveAttribute('type', 'password');
    expect(screen.getByTestId('connect-storeUrl')).toHaveAttribute('type', 'url');
    expect(screen.getByTestId('connect-submit')).toBeDisabled();
    await userEvent.type(screen.getByTestId('connect-storeUrl'), 'https://shop.example.com');
    await userEvent.type(screen.getByTestId('connect-consumerKey'), 'ck_1');
    await userEvent.type(screen.getByTestId('connect-consumerSecret'), 'cs_1');
    expect(connectIntegration).not.toHaveBeenCalled();
    connectIntegration.mockResolvedValue({ ok: true });
    await userEvent.click(screen.getByTestId('connect-submit'));
    expect(connectIntegration).toHaveBeenCalledTimes(1);
    expect(connectIntegration).toHaveBeenCalledWith('bigcommerce', {
      storeUrl: 'https://shop.example.com',
      consumerKey: 'ck_1',
      consumerSecret: 'cs_1',
    });
    expect(refresh).toHaveBeenCalled();
  });

  it('a refusal in words', async () => {
    connectIntegration.mockResolvedValue({ ok: false, reason: 'missing' });
    inIntl(await AvailableSystem({ integration: airtable }));
    await userEvent.type(screen.getByTestId('connect-apiKey'), 'pat');
    await userEvent.click(screen.getByTestId('connect-submit'));
    expect(screen.getByTestId('connect-problem')).toHaveTextContent(
      'Fill in every field, as Airtable gives it.',
    );
    expect(refresh).not.toHaveBeenCalled();
  });

  it('★★ OAuth that comes back here is live: nothing opens without the click; then the provider', async () => {
    inIntl(await AvailableSystem({ integration: hubspot }));
    expect(screen.queryByTestId('connect-drawn')).toBeNull();
    const start = screen.getByTestId('oauth-start');
    expect(start).toHaveTextContent('Connect at HubSpot');
    expect(startOAuth).not.toHaveBeenCalled();
    startOAuth.mockResolvedValue({ ok: true, url: 'https://app.hubspot.com/oauth/authorize?x=1' });
    await userEvent.click(start);
    expect(startOAuth).toHaveBeenCalledWith('hubspot', undefined);
    expect(assign).toHaveBeenCalledWith('https://app.hubspot.com/oauth/authorize?x=1');
  });

  it('Salesforce: its login host, sent with the start; a refusal is said, nothing opened', async () => {
    startOAuth.mockResolvedValue({ ok: false, reason: 'not_configured' });
    inIntl(await AvailableSystem({ integration: salesforce }));
    await userEvent.selectOptions(
      screen.getByTestId('oauth-login-host'),
      'https://test.salesforce.com',
    );
    await userEvent.click(screen.getByTestId('oauth-start'));
    expect(startOAuth).toHaveBeenCalledWith('salesforce', 'https://test.salesforce.com');
    expect(screen.getByTestId('oauth-problem')).toHaveTextContent(
      "Salesforce is not set up on GOTCHA's side yet.",
    );
    expect(assign).not.toHaveBeenCalled();
  });

  it('★ OAuth whose way back is still the old app is drawn, with why; so is no form', async () => {
    const wix = integrationSchema.parse({
      id: 'i-wx',
      slug: 'wix',
      name: 'Wix',
      authType: 'OAUTH2',
      authSchema: { oauth: true, fields: [] },
    });
    const one = inIntl(await AvailableSystem({ integration: wix }));
    expect(screen.queryByTestId('oauth-start')).toBeNull();
    expect(screen.getByTestId('connect-drawn').getAttribute('title')).toMatch(
      /Wix connects at its own site/,
    );
    one.unmount();
    // A new Shopify store is installed from Shopify — not from here.
    const shop = integrationSchema.parse({
      id: 'i-sh',
      slug: 'shopify',
      name: 'Shopify',
      authType: 'OAUTH2',
      authSchema: {
        oauth: true,
        fields: [{ key: 'shop', type: 'text', label: 'Shop domain', required: true }],
      },
    });
    const two = inIntl(
      await AvailableSystem({
        integration: shop,
        shopify: { mode: 'not_published', helpUrl: null },
      }),
    );
    expect(screen.queryByTestId('oauth-start')).toBeNull();
    expect(screen.queryByTestId('connect-form')).toBeNull();
    // 98676242: Shopify's own block — the listing isn't public, so a sentence.
    expect(screen.getByTestId('shopify-not-published')).toBeInTheDocument();
    two.unmount();
    inIntl(await AvailableSystem({ integration: custom }));
    expect(screen.getByTestId('connect-drawn').getAttribute('title')).toMatch(/set up with GOTCHA/);
    expect(screen.getByTestId('available-brings')).toHaveTextContent('—');
  });
});

describe('★★ B — WooCommerce by the store’s approval (no keys typed here)', () => {
  it('only the store address; the store’s page opens on the click', async () => {
    startWooOAuth.mockResolvedValue({
      ok: true,
      url: 'https://shop.example.com/wc-auth/v1/authorize?x',
    });
    inIntl(await AvailableSystem({ integration: woo }));
    expect(screen.queryByTestId('connect-consumerKey')).toBeNull();
    expect(screen.getByTestId('woo-start')).toBeDisabled();
    await userEvent.type(screen.getByTestId('woo-address'), 'shop.example.com');
    expect(startWooOAuth).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('woo-start'));
    expect(startWooOAuth).toHaveBeenCalledWith('shop.example.com');
    expect(assign).toHaveBeenCalledWith('https://shop.example.com/wc-auth/v1/authorize?x');
  });

  it('an address the backend refuses is said; nothing opens', async () => {
    startWooOAuth.mockResolvedValue({ ok: false, reason: 'invalid_store' });
    inIntl(await AvailableSystem({ integration: woo }));
    await userEvent.type(screen.getByTestId('woo-address'), 'nope');
    await userEvent.click(screen.getByTestId('woo-start'));
    expect(screen.getByTestId('woo-problem')).toHaveTextContent(
      "That doesn't look like a store address we can reach — try https://yourstore.com",
    );
    expect(assign).not.toHaveBeenCalled();
  });
});

describe('★★ 1aaaefe4 — keys that do not work: the backend’s sentence, verbatim', () => {
  it('422 with a message shows it; without one, ours', async () => {
    connectIntegration.mockResolvedValue({
      ok: false,
      reason: 'validation',
      message: 'Airtable rejected that token — it needs data.records:read.',
    });
    const one = inIntl(await AvailableSystem({ integration: airtable }));
    await userEvent.type(screen.getByTestId('connect-apiKey'), 'pat');
    await userEvent.click(screen.getByTestId('connect-submit'));
    expect(screen.getByTestId('connect-problem')).toHaveTextContent(
      'Airtable rejected that token — it needs data.records:read.',
    );
    one.unmount();
    connectIntegration.mockResolvedValue({ ok: false, reason: 'validation', message: null });
    inIntl(await AvailableSystem({ integration: airtable }));
    await userEvent.type(screen.getByTestId('connect-apiKey'), 'pat');
    await userEvent.click(screen.getByTestId('connect-submit'));
    expect(screen.getByTestId('connect-problem')).toHaveTextContent(
      "Airtable didn't accept those details.",
    );
  });
});
