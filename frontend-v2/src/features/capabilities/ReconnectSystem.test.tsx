import { render, screen } from '@testing-library/react';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import {
  integrationSchema,
  isConnected,
  needsReconnect,
  splitCatalogue,
} from '@/api/contracts/integrations';
import messages from '@/i18n/messages/en/capabilities.json';
import common from '@/i18n/messages/en/common.json';

vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('./connect-actions', () => ({
  connectIntegration: vi.fn(),
  startOAuth: vi.fn(),
  startWooOAuth: vi.fn(),
}));
vi.mock('./shopify-actions', () => ({
  startShopifyInstall: vi.fn(),
  claimShopifyInstall: vi.fn(),
  verifyShopifyBilling: vi.fn(),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'capabilities') =>
    createTranslator({ locale: 'en', messages: { capabilities: messages, common }, namespace }),
}));

import { AvailableSystem } from './AvailableSystem';
import { ReconnectSystem } from './ReconnectSystem';

/** Dev's Shopify row: ERROR, and its lastError is a raw HTML 401 page. */
const HTML_401 = '<!DOCTYPE html><html><head><title>401 Unauthorized</title></head></html>';

const system = (over: Record<string, unknown>, connection: Record<string, unknown> | null) =>
  integrationSchema.parse({
    id: 'i1',
    slug: 'pipedrive',
    name: 'Pipedrive',
    authSchema: { fields: [{ key: 'apiToken', type: 'password', label: 'API token' }] },
    tenantConnection: connection === null ? null : { id: 'c1', ...connection },
    ...over,
  });

const show = async (node: Promise<React.ReactElement>) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ capabilities: messages, common }}>
      {await node}
    </NextIntlClientProvider>,
  );

describe('★★ a connection’s state - ERROR, CONNECTED, DISCONNECTED and no row at all', () => {
  it('ERROR is connected AND needs a reconnect; CONNECTED needs nothing', () => {
    const broken = system({}, { status: 'ERROR', lastError: HTML_401 });
    const fine = system({}, { status: 'CONNECTED' });
    expect(isConnected(broken)).toBe(true);
    expect(needsReconnect(broken)).toBe(true);
    expect(isConnected(fine)).toBe(true);
    expect(needsReconnect(fine)).toBe(false);
  });

  it('★ a DISCONNECTED row is not connected - it is available again, like no row', () => {
    const left = system({}, { status: 'DISCONNECTED', lastError: 'x' });
    const none = system({}, null);
    for (const entry of [left, none]) {
      expect(isConnected(entry)).toBe(false);
      expect(needsReconnect(entry)).toBe(false);
    }
    const { connected, available } = splitCatalogue([left, none]);
    expect(connected).toHaveLength(0);
    expect(available).toHaveLength(2);
  });
});

describe('★★ a broken system has a way back - Reconnect, by the flow it connects with', () => {
  it('ERROR: its actions are paused, the reason in words - never the stored HTML', async () => {
    await show(
      ReconnectSystem({
        integration: system({}, { status: 'ERROR', lastError: HTML_401 }),
        showReason: true,
      }),
    );
    expect(screen.getByTestId('reconnect-card')).toHaveTextContent('Reconnect Pipedrive');
    expect(screen.getByTestId('reconnect-what')).toHaveTextContent(
      'The connection to Pipedrive stopped working, so its actions are paused until it is reconnected.',
    );
    expect(screen.getByTestId('reconnect-reason')).toHaveTextContent(
      'Something went wrong with the connection to Pipedrive.',
    );
    expect(screen.getByTestId('reconnect-card')).not.toHaveTextContent(/DOCTYPE|401|channel/);
    // A key system's way back is its own form, which replaces the keys in place.
    expect(screen.getByTestId('connect-form')).toBeInTheDocument();
  });

  it('a known code is said in its words; the header carries it when told to', async () => {
    const one = await show(
      ReconnectSystem({
        integration: system(
          {},
          { status: 'ERROR', lastError: 'x', lastErrorCode: 'SHOPIFY_APP_UNINSTALLED' },
        ),
        showReason: true,
      }),
    );
    expect(screen.getByTestId('reconnect-reason')).toHaveTextContent(
      'The GOTCHA app was removed from the store.',
    );
    one.unmount();
    await show(
      ReconnectSystem({
        integration: system({}, { status: 'ERROR', lastError: 'x' }),
        showReason: false,
      }),
    );
    expect(screen.queryByTestId('reconnect-reason')).toBeNull();
  });

  it('a failed check on a CONNECTED row is not "paused" - its actions still run', async () => {
    await show(
      ReconnectSystem({
        integration: system({}, { status: 'CONNECTED', lastTestResult: false }),
        showReason: true,
      }),
    );
    expect(screen.getByTestId('reconnect-what')).toHaveTextContent(
      'The last check against Pipedrive failed. Its actions still run',
    );
  });

  it('an OAuth system reconnects at its provider', async () => {
    await show(
      ReconnectSystem({
        integration: system(
          { slug: 'hubspot', name: 'HubSpot', authSchema: { oauth: true, fields: [] } },
          { status: 'ERROR' },
        ),
        showReason: true,
      }),
    );
    expect(screen.getByTestId('oauth-start')).toHaveTextContent('Reconnect HubSpot');
  });

  it('★ Shopify re-authorises the store it has - never a new install', async () => {
    await show(
      ReconnectSystem({
        integration: system(
          { slug: 'shopify', name: 'Shopify', authSchema: {} },
          { status: 'ERROR' },
        ),
        showReason: true,
      }),
    );
    expect(screen.getByTestId('oauth-start')).toHaveTextContent('Reconnect Shopify');
    expect(screen.queryByTestId('shopify-start')).toBeNull();
    expect(screen.queryByTestId('shopify-not-published')).toBeNull();
  });
});

describe('★ a DISCONNECTED system is available again - and says so, and why', () => {
  it('"Disconnected", its reason in words, and its Connect', async () => {
    await show(
      AvailableSystem({
        integration: system(
          {},
          { status: 'DISCONNECTED', lastError: 'x', lastErrorCode: 'SHOPIFY_APP_UNINSTALLED' },
        ),
      }),
    );
    expect(screen.getByTestId('system-state')).toHaveTextContent('Disconnected');
    expect(screen.getByTestId('system-error')).toHaveTextContent(
      'The GOTCHA app was removed from the store.',
    );
    expect(screen.getByTestId('connect-form')).toBeInTheDocument();
  });

  it('no row: "Not connected", and no reason', async () => {
    await show(AvailableSystem({ integration: system({}, null) }));
    expect(screen.getByTestId('system-state')).toHaveTextContent('Not connected');
    expect(screen.queryByTestId('system-error')).toBeNull();
  });
});
