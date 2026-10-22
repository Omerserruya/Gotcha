import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { widgetInstallSchema, type WidgetInstall } from '@/api/contracts/website-widget';
import channels from '@/i18n/messages/en/channels.json';

const download = vi.hoisted(() => vi.fn());
vi.mock('@/api/client/download', () => ({ downloadFromPlatform: download }));
const remove = vi.hoisted(() => vi.fn());
vi.mock('./woo-plugin-actions', () => ({ removeWooSite: remove }));
const refresh = vi.hoisted(() => vi.fn());
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { WooPlugin } from './WooPlugin';

beforeEach(() => {
  download.mockReset();
  remove.mockReset();
  refresh.mockReset();
});

const install = (woocommerce: unknown) =>
  widgetInstallSchema.parse({ data: { code: null, shopify: [], woocommerce } }).data;
const LIVE = {
  status: 'plugin',
  sites: [
    {
      id: 's1',
      siteUrl: 'https://shop.example.com',
      status: 'connected',
      lastSeenAt: '2026-10-07T09:00:00Z',
      pluginVersion: '1.0.0',
    },
    { id: 's2', siteUrl: 'https://old.example.com', status: 'removed', lastSeenAt: null },
  ],
  downloadUrl: '/api/woocommerce-plugin/download',
};

const show = (woo: WidgetInstall['woocommerce']) =>
  render(
    <NextIntlClientProvider locale="en" timeZone="Asia/Jerusalem" messages={{ channels }}>
      <WooPlugin woo={woo} />
    </NextIntlClientProvider>,
  );

describe('★ the install read: WooCommerce by its plugin (§5)', () => {
  it('a service before the plugin: no sites, no zip - and an absent object is that too', () => {
    expect(install({ status: 'use_code' }).woocommerce).toEqual({
      status: 'use_code',
      sites: [],
      downloadUrl: null,
    });
    expect(
      widgetInstallSchema.parse({ data: { code: null, shopify: [] } }).data.woocommerce.sites,
    ).toEqual([]);
  });

  it('★ a site in a state the screen cannot name fails the read - never "Connected"', () => {
    expect(() => install({ ...LIVE, sites: [{ ...LIVE.sites[0], status: 'paused' }] })).toThrow();
  });
});

describe('★★ Install · WooCommerce', () => {
  it('no plugin on the service: the status it was, and the code below', () => {
    show(install({ status: 'use_code' }).woocommerce);
    expect(screen.getByTestId('webchat-woo-action')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByTestId('webchat-woo-download')).toBeNull();
  });

  it('the plugin: download, the steps, and each site with what it last said', () => {
    show(install(LIVE).woocommerce);
    expect(screen.getByTestId('webchat-woo-steps')).toHaveTextContent(
      'Download "GOTCHA for WooCommerce", then in WordPress: Plugins → Add New → Upload Plugin.',
    );
    expect(screen.getByTestId('webchat-woo-status-s1')).toHaveTextContent('Connected');
    expect(screen.getByTestId('webchat-woo-line-s1')).toHaveTextContent(
      'The plugin shows the chat on this site. Last heard from Oct 7. Plugin 1.0.0.',
    );
    expect(screen.getByTestId('webchat-woo-site-s1')).toHaveTextContent('shop.example.com');
    // A removed site has nothing to disconnect.
    expect(screen.getByTestId('webchat-woo-status-s2')).toHaveTextContent('Removed');
    expect(screen.queryByTestId('webchat-woo-remove-s2')).toBeNull();
  });

  it('★ the zip through the BFF; a refusal is said, never saved as a file', async () => {
    download.mockResolvedValueOnce({ ok: false, status: 403 });
    show(install(LIVE).woocommerce);
    await act(async () => {
      fireEvent.click(screen.getByTestId('webchat-woo-download'));
    });
    expect(download).toHaveBeenCalledWith('/api/woocommerce-plugin/download');
    expect(screen.getByTestId('webchat-woo-download-failed')).toHaveTextContent(
      'You need permission to connect business systems',
    );
  });

  it('only the platform’s own path is fetched', () => {
    show(install({ ...LIVE, downloadUrl: 'https://evil.example/zip' }).woocommerce);
    expect(screen.queryByTestId('webchat-woo-download')).toBeNull();
  });

  it('Disconnect asks, then removes the site', async () => {
    remove.mockResolvedValueOnce({ ok: true });
    show(install(LIVE).woocommerce);
    fireEvent.click(screen.getByTestId('webchat-woo-remove-s1'));
    expect(screen.getByTestId('webchat-woo-remove-dialog')).toHaveTextContent(
      'Disconnect shop.example.com?',
    );
    expect(remove).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByTestId('webchat-woo-remove-yes'));
    });
    expect(remove).toHaveBeenCalledWith('s1');
    expect(refresh).toHaveBeenCalled();
    expect(screen.queryByTestId('webchat-woo-remove-dialog')).toBeNull();
  });

  it('a refused disconnect is said, and the dialog stays', async () => {
    remove.mockResolvedValueOnce({ ok: false, reason: 'forbidden' });
    show(install(LIVE).woocommerce);
    fireEvent.click(screen.getByTestId('webchat-woo-remove-s1'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('webchat-woo-remove-yes'));
    });
    expect(screen.getByTestId('webchat-woo-remove-failed')).toHaveTextContent(
      'You need permission to disconnect',
    );
    expect(refresh).not.toHaveBeenCalled();
  });
});
