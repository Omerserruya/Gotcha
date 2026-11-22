import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConsoleRequest } from '@/api/contracts/shopify-private-apps';
import messages from '@/i18n/messages/en/console.json';

/** The console section. Every action is mocked: no link is stored, sent, revoked or granted. */
const saveShopifyPrivateAppsSettings = vi.hoisted(() => vi.fn());
const sendShopifyCustomAppLink = vi.hoisted(() => vi.fn());
const sendShopifyCustomAppNewLink = vi.hoisted(() => vi.fn());
const shopifyCustomAppStep = vi.hoisted(() => vi.fn());
vi.mock('./shopify-private-actions', () => ({
  saveShopifyPrivateAppsSettings,
  sendShopifyCustomAppLink,
  sendShopifyCustomAppNewLink,
  shopifyCustomAppStep,
}));

import { ShopifyPrivateApps } from './ShopifyPrivateApps';

const row = (over: Partial<ConsoleRequest> = {}): ConsoleRequest => ({
  tenantId: 't1',
  tenantName: 'Acme',
  status: 'requested',
  shopDomain: 'acme.myshopify.com',
  requestedAt: '2026-11-22T10:00:00.000Z',
  linkExpiresAt: null,
  installedAt: null,
  clientId: null,
  ...over,
});
const LINK = 'https://admin.shopify.com/oauth/install_custom_app?client_id=cid';

const draw = (
  requests: ConsoleRequest[] | null = [row()],
  settings: { enabled: boolean; entitlement: 'included' | 'manual' } | null = {
    enabled: true,
    entitlement: 'included',
  },
) =>
  render(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={{ console: messages }}>
      <ShopifyPrivateApps read={{ settings, requests }} />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  for (const m of [
    saveShopifyPrivateAppsSettings,
    sendShopifyCustomAppLink,
    sendShopifyCustomAppNewLink,
    shopifyCustomAppStep,
  ]) {
    m.mockReset();
    m.mockResolvedValue({ ok: true });
  }
});

describe('★★ paste the app, then send the link - asked first', () => {
  it('nothing is sent before the confirm; then the app, secret included, goes once', async () => {
    draw();
    await userEvent.click(screen.getByTestId('shopify-app-t1-link'));
    const next = screen.getByTestId('shopify-app-t1-next');
    expect(next).toBeDisabled();
    await userEvent.type(screen.getByTestId('shopify-app-t1-client-id'), 'cid');
    await userEvent.type(screen.getByTestId('shopify-app-t1-client-secret'), 'shpss_x');
    await userEvent.type(screen.getByTestId('shopify-app-t1-install-link'), LINK);
    await userEvent.click(next);
    expect(sendShopifyCustomAppLink).not.toHaveBeenCalled();
    expect(screen.getByTestId('shopify-app-t1-confirm')).toHaveTextContent(
      'Store the app for acme.myshopify.com and email the install link to Acme?',
    );
    await userEvent.click(screen.getByTestId('shopify-app-t1-go'));
    expect(sendShopifyCustomAppLink).toHaveBeenCalledWith('t1', {
      clientId: 'cid',
      clientSecret: 'shpss_x',
      installLink: LINK,
      linkExpiresAt: '',
    });
    expect(await screen.findByTestId('shopify-apps-done')).toBeInTheDocument();
  });

  it('★★ the secret field is write-only: a password field, empty again after a refusal', async () => {
    sendShopifyCustomAppLink.mockResolvedValue({ ok: false, reason: 'wrong_state' });
    draw();
    await userEvent.click(screen.getByTestId('shopify-app-t1-link'));
    const secret = screen.getByTestId('shopify-app-t1-client-secret');
    expect(secret).toHaveAttribute('type', 'password');
    expect(secret).toHaveAttribute('autocomplete', 'new-password');
    await userEvent.type(screen.getByTestId('shopify-app-t1-client-id'), 'cid');
    await userEvent.type(secret, 'shpss_x');
    await userEvent.type(screen.getByTestId('shopify-app-t1-install-link'), LINK);
    await userEvent.click(screen.getByTestId('shopify-app-t1-next'));
    await userEvent.click(screen.getByTestId('shopify-app-t1-go'));
    expect(await screen.findByTestId('shopify-apps-refused')).toHaveTextContent(
      'This request moved on meanwhile.',
    );
    expect(screen.getByTestId('shopify-app-t1-client-secret')).toHaveValue('');
  });

  it('a link that is not Shopify’s admin: said at the field, and no way on', async () => {
    draw();
    await userEvent.click(screen.getByTestId('shopify-app-t1-link'));
    await userEvent.type(screen.getByTestId('shopify-app-t1-client-id'), 'cid');
    await userEvent.type(screen.getByTestId('shopify-app-t1-client-secret'), 's');
    await userEvent.type(
      screen.getByTestId('shopify-app-t1-install-link'),
      'https://evil.example/x',
    );
    expect(screen.getByText(/It starts with https:\/\/admin\.shopify\.com\//)).toBeInTheDocument();
    expect(screen.getByTestId('shopify-app-t1-next')).toBeDisabled();
  });
});

describe('★★ each state offers its own steps', () => {
  it.each([
    ['requested', 'included', ['link']],
    ['link_sent', 'included', ['newLink', 'revoke']],
    ['installed', 'included', ['revoke']],
    ['revoked', 'included', []],
    ['revoked', 'manual', ['grant']],
    ['requested', 'manual', ['link', 'grant']],
  ] as const)('%s (%s): %j', (status, entitlement, steps) => {
    draw([row({ status })], { enabled: true, entitlement });
    const drawn = ['link', 'newLink', 'revoke', 'grant'].filter(
      (step) => screen.queryByTestId(`shopify-app-t1-${step}`) !== null,
    );
    expect(drawn).toEqual(steps);
  });

  it('revoke asks first, naming the store and the workspace', async () => {
    draw([row({ status: 'installed' })]);
    await userEvent.click(screen.getByTestId('shopify-app-t1-revoke'));
    await userEvent.click(screen.getByTestId('shopify-app-t1-next'));
    expect(shopifyCustomAppStep).not.toHaveBeenCalled();
    expect(screen.getByTestId('shopify-app-t1-confirm')).toHaveTextContent(
      'Revoke the private app for acme.myshopify.com (Acme)?',
    );
    await userEvent.click(screen.getByTestId('shopify-app-t1-go'));
    expect(shopifyCustomAppStep).toHaveBeenCalledWith('t1', 'revoke');
  });
});

describe('★ the switch, and the unread states', () => {
  it('the switch and the entitlement are saved together, only once changed', async () => {
    draw();
    expect(screen.getByTestId('shopify-apps-save')).toBeDisabled();
    await userEvent.selectOptions(screen.getByTestId('shopify-apps-entitlement'), 'manual');
    await userEvent.click(screen.getByTestId('shopify-apps-save'));
    expect(saveShopifyPrivateAppsSettings).toHaveBeenCalledWith({
      enabled: true,
      entitlement: 'manual',
    });
  });

  it('unread is said, never an empty list or a switch that looks off', () => {
    draw(null, null);
    expect(screen.getByTestId('shopify-apps-settings-unread')).toBeInTheDocument();
    expect(screen.getByTestId('shopify-apps-requests-unread')).toBeInTheDocument();
    expect(screen.queryByTestId('shopify-apps-requests-none')).toBeNull();
  });
});
