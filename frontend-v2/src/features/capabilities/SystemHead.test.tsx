import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { capabilitySchema } from '@/api/contracts/capabilities';
import { integrationSchema } from '@/api/contracts/integrations';
import messages from '@/i18n/messages/en/capabilities.json';
import common from '@/i18n/messages/en/common.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'capabilities') =>
    createTranslator({ locale: 'en', messages: { capabilities: messages, common }, namespace }),
  getFormatter: async () => createFormatter({ locale: 'en' }),
}));

import { SystemHead } from './SystemHead';

const shopify = integrationSchema.parse({
  id: 'i1',
  slug: 'shopify',
  name: 'Shopify',
  tenantConnection: { id: 'c1', status: 'CONNECTED' },
});
const caps = ['shopify.a', 'shopify.b'].map((toolName) =>
  capabilitySchema.parse({ toolName, integration: 'shopify' }),
);
const usage = [
  {
    toolName: 'shopify.a',
    executionCount: 1200,
    erroredCount: 0,
    unclassifiedFailureCount: 0,
    refusedCount: 0,
  },
  {
    toolName: 'shopify.b',
    executionCount: 640,
    erroredCount: 0,
    unclassifiedFailureCount: 0,
    refusedCount: 0,
  },
] as never;

describe('★ 10’s system header', () => {
  it('★★ sums its actions’ runs and NAMES the window - 30 days, never "this week"', async () => {
    render(await SystemHead({ integration: shopify, capabilities: caps, usage }));
    expect(screen.getByTestId('system-line')).toHaveTextContent(
      'Used 1,840 times in the last 30 days',
    );
    expect(screen.getByTestId('system-line')).not.toHaveTextContent(/week/);
    expect(screen.getByTestId('system-state')).toHaveTextContent('Connected');
  });

  it('⚠ a failed usage read prints no count - it says how many actions instead', async () => {
    render(await SystemHead({ integration: shopify, capabilities: caps, usage: null }));
    expect(screen.getByTestId('system-line')).toHaveTextContent('2 actions');
  });

  it('the built-in actions have a name and no connection to show', async () => {
    render(await SystemHead({ integration: null, capabilities: caps, usage: null }));
    expect(screen.getByTestId('system-head')).toHaveTextContent('Built into GOTCHA');
    expect(screen.queryByTestId('system-state')).toBeNull();
  });
});

describe('★ the system’s mark', () => {
  it('its own logo; the built-in actions get the plug', async () => {
    const one = render(await SystemHead({ integration: shopify, capabilities: caps, usage: null }));
    expect(screen.getByTestId('system-head').querySelector('img')?.getAttribute('src')).toMatch(
      /\/integrations\/shopify\.svg$/,
    );
    one.unmount();
    render(await SystemHead({ integration: null, capabilities: caps, usage: null }));
    expect(screen.getByTestId('system-head').querySelector('img')).toBeNull();
  });
});

describe('★★ the connection’s last error, in words, under its line', () => {
  const broken = (connection: Record<string, unknown>) =>
    integrationSchema.parse({
      id: 'i1',
      slug: 'shopify',
      name: 'Shopify',
      tenantConnection: { id: 'c1', status: 'DISCONNECTED', ...connection },
    });

  it('by its code; a "[CODE] " left on the sentence is read the same and never printed', async () => {
    const words = 'The GOTCHA app was removed from the store. Install it again to reconnect.';
    const one = render(
      await SystemHead({
        integration: broken({ lastError: 'x', lastErrorCode: 'SHOPIFY_APP_UNINSTALLED' }),
        capabilities: caps,
        usage: null,
      }),
    );
    expect(screen.getByTestId('system-error')).toHaveTextContent(words);
    one.unmount();
    render(
      await SystemHead({
        integration: broken({
          lastError:
            '[SHOPIFY_APP_UNINSTALLED] The GOTCHA Shopify app was uninstalled from this store.',
        }),
        capabilities: caps,
        usage: null,
      }),
    );
    expect(screen.getByTestId('system-error')).toHaveTextContent(words);
    expect(screen.getByTestId('system-head')).not.toHaveTextContent('[SHOPIFY');
  });

  it('★ an unrecognised error (dev: a raw HTML 401) names the system - never "this channel", never the text', async () => {
    render(
      await SystemHead({
        integration: broken({ status: 'ERROR', lastError: '<!DOCTYPE html><title>401</title>' }),
        capabilities: caps,
        usage: null,
      }),
    );
    expect(screen.getByTestId('system-error')).toHaveTextContent(
      'Something went wrong with the connection to Shopify.',
    );
    expect(screen.getByTestId('system-head')).not.toHaveTextContent(/channel|DOCTYPE|401/);
  });

  it('a healthy connection has no error line', async () => {
    render(await SystemHead({ integration: shopify, capabilities: caps, usage: null }));
    expect(screen.queryByTestId('system-error')).toBeNull();
  });
});
