import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MerchantRequest } from '@/api/contracts/shopify-private-apps';
import messages from '@/i18n/messages/en/capabilities.json';

/** The private-app card. The action is mocked: nothing here asks Shopify or GOTCHA for anything. */
const requestShopifyPrivateApp = vi.hoisted(() => vi.fn());
vi.mock('./shopify-private-actions', () => ({ requestShopifyPrivateApp }));

import { ShopifyPrivateRequest } from './ShopifyPrivateRequest';

const draw = (request: MerchantRequest | null | undefined) =>
  render(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={{ capabilities: messages }}>
      <ShopifyPrivateRequest request={request} />
    </NextIntlClientProvider>,
  );

const req = (over: Partial<MerchantRequest> = {}): MerchantRequest => ({
  status: 'requested',
  shopDomain: 'my-store.myshopify.com',
  requestedAt: null,
  linkExpiresAt: null,
  installLink: null,
  ...over,
});

beforeEach(() => {
  requestShopifyPrivateApp.mockReset();
});

describe('★★ no request: the address, then "request sent"', () => {
  it('a bare name becomes the store address; the card then says what comes next', async () => {
    requestShopifyPrivateApp.mockResolvedValue({ ok: true, request: req() });
    draw(null);
    await userEvent.type(screen.getByTestId('shopify-private-address'), 'my-store');
    await userEvent.click(screen.getByTestId('shopify-private-submit'));
    expect(requestShopifyPrivateApp).toHaveBeenCalledWith('my-store.myshopify.com');
    expect(await screen.findByTestId('shopify-private-sent')).toHaveTextContent(
      'Request sent for my-store.myshopify.com. We’re preparing a private install link, and it will reach you by email.',
    );
  });

  it('not a store address: said at the field, nothing sent', async () => {
    draw(null);
    await userEvent.type(screen.getByTestId('shopify-private-address'), 'my-store.com');
    await userEvent.click(screen.getByTestId('shopify-private-submit'));
    expect(requestShopifyPrivateApp).not.toHaveBeenCalled();
    expect(screen.getByText(/like your-store\.myshopify\.com/)).toBeInTheDocument();
  });

  it('a refusal is its own line, and the form stays', async () => {
    requestShopifyPrivateApp.mockResolvedValue({ ok: false, reason: 'shop_requested_elsewhere' });
    draw(null);
    await userEvent.type(screen.getByTestId('shopify-private-address'), 'my-store.myshopify.com');
    await userEvent.click(screen.getByTestId('shopify-private-submit'));
    expect(await screen.findByTestId('shopify-private-problem')).toHaveTextContent(
      'my-store.myshopify.com was already requested by another GOTCHA workspace.',
    );
    expect(screen.getByTestId('shopify-private-address')).toBeInTheDocument();
  });
});

describe('★★ a request made: its state, said', () => {
  it('link_sent: a real button to Shopify’s install page, and its expiry', () => {
    draw(
      req({
        status: 'link_sent',
        installLink: 'https://admin.shopify.com/oauth/install_custom_app?client_id=x',
        linkExpiresAt: '2026-12-01T23:59:59.000Z',
      }),
    );
    expect(screen.getByTestId('shopify-private-install')).toHaveAttribute(
      'href',
      'https://admin.shopify.com/oauth/install_custom_app?client_id=x',
    );
    expect(screen.getByTestId('shopify-private-sent')).toHaveTextContent(
      'The link works until 12/1/2026.',
    );
  });

  it('link_sent with no link (expired): said, with no dead button', () => {
    draw(req({ status: 'link_sent' }));
    expect(screen.getByTestId('shopify-private-sent')).toHaveAttribute('data-state', 'expired');
    expect(screen.queryByTestId('shopify-private-install')).toBeNull();
  });

  it('revoked: said, and a store can be asked for again', () => {
    draw(req({ status: 'revoked' }));
    expect(screen.getByTestId('shopify-private-revoked')).toBeInTheDocument();
    expect(screen.getByTestId('shopify-private-address')).toBeInTheDocument();
  });

  it('★ unread: said - the form is never offered over a request that may exist', () => {
    draw(undefined);
    expect(screen.getByTestId('shopify-private-unread')).toBeInTheDocument();
    expect(screen.queryByTestId('shopify-private-address')).toBeNull();
  });

  it('installed: nothing here - the store is connected, and that is the page’s own card', () => {
    const { container } = draw(req({ status: 'installed' }));
    expect(container).toBeEmptyDOMElement();
  });
});
