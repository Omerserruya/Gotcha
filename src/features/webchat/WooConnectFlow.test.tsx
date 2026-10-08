import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import channels from '@/i18n/messages/en/channels.json';

const actions = vi.hoisted(() => ({ bindWooPlugin: vi.fn(), startWooPluginStore: vi.fn() }));
vi.mock('./woo-plugin-actions', () => actions);

import { linkOf, WOO_LINK_KEY, WooConnectFlow } from './WooConnectFlow';

const SITE = 'https://shop.example.com';
const RETURN = 'https://shop.example.com/wp-admin/admin.php?page=gotcha';
const NONCE = 'n0nce_abcdef12';
const ASKED = { site: SITE, returnUrl: RETURN, nonce: NONCE };
const NONE = { site: null, returnUrl: null, nonce: null };

const assign = vi.fn();
beforeEach(() => {
  actions.bindWooPlugin.mockReset();
  actions.startWooPluginStore.mockReset();
  assign.mockReset();
  window.sessionStorage.clear();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, assign },
  });
});

const show = (props: Partial<Parameters<typeof WooConnectFlow>[0]> = {}) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ channels }}>
      <WooConnectFlow
        asked={ASKED}
        back={null}
        workspace="Aviv"
        store={SITE}
        hasWidget
        {...props}
      />
    </NextIntlClientProvider>,
  );
const click = (id: string) =>
  act(async () => {
    fireEvent.click(screen.getByTestId(id));
  });

describe('★★ what WordPress sent - checked before a button is offered', () => {
  it.each([
    [ASKED, true],
    [{ ...ASKED, returnUrl: 'https://evil.example/wp-admin/x' }, false],
    [{ ...ASKED, returnUrl: 'https://shop.example.com/account' }, false],
    [{ ...ASKED, site: 'javascript:alert(1)' }, false],
    [{ ...ASKED, nonce: null }, false],
  ])('%j → %s', (asked, ok) => {
    expect(linkOf(asked) !== null).toBe(ok);
  });
});

describe('★★ "Connect to GOTCHA" from the WooCommerce plugin', () => {
  it('says which site and which workspace; nothing happens until Connect', async () => {
    actions.bindWooPlugin.mockResolvedValue({ ok: true, redirect: `${RETURN}&gotcha_code=c` });
    show();
    expect(screen.getByTestId('woo-connect-title')).toHaveTextContent(
      'Connect shop.example.com to GOTCHA',
    );
    expect(screen.getByTestId('woo-connect-workspace')).toHaveTextContent('Workspace: Aviv');
    expect(screen.getByTestId('woo-connect-store')).toHaveTextContent(
      'shop.example.com is connected to this workspace.',
    );
    expect(actions.bindWooPlugin).not.toHaveBeenCalled();
    // Kept for the round-trip through the store's approval.
    expect(JSON.parse(window.sessionStorage.getItem(WOO_LINK_KEY)!)).toEqual(ASKED);

    await click('woo-connect-yes');
    expect(actions.bindWooPlugin).toHaveBeenCalledWith(ASKED, { createWidget: false });
    expect(assign).toHaveBeenCalledWith(`${RETURN}&gotcha_code=c`);
    expect(window.sessionStorage.getItem(WOO_LINK_KEY)).toBeNull();
  });

  it('no web chat yet: says it is created, and asks for it', async () => {
    actions.bindWooPlugin.mockResolvedValue({ ok: false, reason: 'failed' });
    show({ hasWidget: false });
    expect(screen.getByTestId('woo-connect-widget')).toHaveTextContent('website chat is created');
    await click('woo-connect-yes');
    expect(actions.bindWooPlugin).toHaveBeenCalledWith(ASKED, { createWidget: true });
    expect(screen.getByTestId('woo-connect-problem')).toHaveTextContent("It didn't connect");
    expect(assign).not.toHaveBeenCalled();
  });

  it('★ the store not connected: it approves first, and comes back here', async () => {
    actions.startWooPluginStore.mockResolvedValue({
      ok: true,
      url: `${SITE}/wc-auth/v1/authorize`,
    });
    show({ store: 'none' });
    expect(screen.queryByTestId('woo-connect-yes')).toBeNull();
    await click('woo-connect-approve');
    expect(actions.startWooPluginStore).toHaveBeenCalledWith(SITE);
    expect(assign).toHaveBeenCalledWith(`${SITE}/wc-auth/v1/authorize`);
  });

  it('★ back from the approval with nothing in the address: the kept link, and Connect', async () => {
    window.sessionStorage.setItem(WOO_LINK_KEY, JSON.stringify(ASKED));
    actions.bindWooPlugin.mockResolvedValue({ ok: true, redirect: RETURN });
    show({ asked: NONE, back: 'connected', store: 'none' });
    expect(screen.getByTestId('woo-connect-store')).toHaveTextContent('is connected');
    await click('woo-connect-yes');
    expect(actions.bindWooPlugin).toHaveBeenCalledWith(ASKED, { createWidget: false });
  });

  it('the approval refused: said, and Approve again', () => {
    window.sessionStorage.setItem(WOO_LINK_KEY, JSON.stringify(ASKED));
    show({ asked: NONE, back: 'denied', store: 'none' });
    expect(screen.getByTestId('woo-connect-back-error')).toHaveTextContent(
      "The store didn't approve GOTCHA",
    );
    expect(screen.getByTestId('woo-connect-approve')).toBeInTheDocument();
  });

  it('another store on this workspace: said - and no button that can only fail', () => {
    show({ store: 'https://other-shop.example.com' });
    expect(screen.getByTestId('woo-connect-store')).toHaveTextContent(
      'connected to another store, other-shop.example.com',
    );
    expect(screen.queryByTestId('woo-connect-yes')).toBeNull();
    expect(screen.queryByTestId('woo-connect-approve')).toBeNull();
    expect(screen.getByTestId('woo-connect-cancel')).toHaveAttribute('href', RETURN);
  });

  it('binding says the store is not connected after all: Approve takes Connect’s place', async () => {
    actions.bindWooPlugin.mockResolvedValue({ ok: false, reason: 'store_not_connected' });
    show({ store: null });
    await click('woo-connect-yes');
    expect(screen.getByTestId('woo-connect-approve')).toBeInTheDocument();
  });

  it('no link in the address or the session: says to press Connect again in WordPress', () => {
    show({ asked: NONE });
    expect(screen.getByTestId('woo-connect-incomplete')).toHaveTextContent(
      'Press "Connect to GOTCHA" in WordPress again.',
    );
    expect(screen.queryByTestId('woo-connect-yes')).toBeNull();
  });
});
