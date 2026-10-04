import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { capabilitySchema } from '@/api/contracts/capabilities';
import { integrationSchema } from '@/api/contracts/integrations';
import messages from '@/i18n/messages/en/capabilities.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'capabilities') =>
    createTranslator({ locale: 'en', messages: { capabilities: messages }, namespace }),
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
  it('★★ sums its actions’ runs and NAMES the window — 30 days, never "this week"', async () => {
    render(await SystemHead({ integration: shopify, capabilities: caps, usage }));
    expect(screen.getByTestId('system-line')).toHaveTextContent(
      'Used 1,840 times in the last 30 days',
    );
    expect(screen.getByTestId('system-line')).not.toHaveTextContent(/week/);
    expect(screen.getByTestId('system-state')).toHaveTextContent('Connected');
  });

  it('⚠ a failed usage read prints no count — it says how many actions instead', async () => {
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
