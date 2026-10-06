import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { capabilitySchema } from '@/api/contracts/capabilities';
import { integrationSchema } from '@/api/contracts/integrations';
import { AvailableSystem } from '@/features/capabilities/AvailableSystem';
import { CapabilityScreen } from '@/features/capabilities/CapabilityScreen';
import { OAuthLanding } from '@/features/capabilities/OAuthLanding';
import { SystemHead } from '@/features/capabilities/SystemHead';

const loadCapabilities = vi.hoisted(() => vi.fn());
vi.mock('@/features/capabilities/load-capabilities', () => ({ loadCapabilities }));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('server-only', () => ({}));
vi.mock('@/i18n/navigation', () => ({ Link: 'a', useRouter: () => ({}) }));

/** The detail and the rail are props of the split, not children: visit both. */
const find = <T,>(tree: ReactNode, type: unknown): T | null => {
  let found: T | null = null;
  const visit = (node: ReactNode): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!isValidElement(node)) return;
    if (node.type === type) found = node.props as T;
    const props = (
      node as ReactElement<{ children?: ReactNode; detail?: ReactNode; list?: ReactNode }>
    ).props;
    visit(props.children);
    visit(props.detail);
    visit(props.list);
  };
  visit(tree);
  return found;
};

const page = async (params: Record<string, string> = {}) => {
  const { default: Page } = await import('./page');
  return Page({ searchParams: Promise.resolve(params) });
};

const shopify = integrationSchema.parse({
  id: 'i1',
  slug: 'shopify',
  name: 'Shopify',
  tenantConnection: { id: 'c1', status: 'ERROR' },
});
const woo = integrationSchema.parse({ id: 'i2', slug: 'woocommerce', name: 'WooCommerce' });

beforeEach(() => {
  loadCapabilities.mockReset();
  loadCapabilities.mockResolvedValue({
    capabilities: [
      capabilitySchema.parse({
        toolName: 'shopify.cancel_order',
        integration: 'shopify',
        riskLevel: 'HIGH',
      }),
    ],
    usage: null,
    integrations: [shopify, woo],
  });
});

describe('★★ 10 - every integration has its own screen', () => {
  it('?system=<not connected> is that system’s screen, with Connect - not the permissions', async () => {
    const tree = await page({ system: 'woocommerce' });
    expect(find<{ integration: { slug: string } }>(tree, AvailableSystem)?.integration.slug).toBe(
      'woocommerce',
    );
    expect(find(tree, CapabilityScreen)).toBeNull();
  });

  it('?system=<connected, even broken> is its permissions', async () => {
    const tree = await page({ system: 'shopify' });
    expect(find(tree, AvailableSystem)).toBeNull();
    expect(
      find<{ capabilities: { toolName: string }[] }>(tree, CapabilityScreen)?.capabilities,
    ).toHaveLength(1);
    // Its catalogue names its rows.
    expect(
      find<{ integration: { slug: string } | null }>(tree, CapabilityScreen)?.integration?.slug,
    ).toBe('shopify');
    expect(find(tree, SystemHead)).not.toBeNull();
  });

  it('even when the permissions read failed, an available system still opens', async () => {
    loadCapabilities.mockResolvedValue({
      capabilities: null,
      usage: null,
      integrations: [shopify, woo],
    });
    expect(find(await page({ system: 'woocommerce' }), AvailableSystem)).not.toBeNull();
  });
});

describe('★★ the way back from a provider', () => {
  it.each([
    [{ system: 'shopify', connected: '1' }, 'connected'],
    [{ system: 'shopify', error: 'denied' }, 'denied'],
    [{ system: 'shopify', error: 'made_up' }, 'other'],
  ])('%o → said as %s, above the system', async (params, outcome) => {
    const tree = await page(params);
    expect(find<{ outcome: string; slug: string }>(tree, OAuthLanding)).toMatchObject({
      outcome,
      slug: 'shopify',
    });
  });

  it('no return: mounted with nothing to say (it holds a sentence across the URL tidy)', async () => {
    expect(
      find<{ outcome: string | null }>(await page({ system: 'shopify' }), OAuthLanding)?.outcome,
    ).toBeNull();
  });
});
