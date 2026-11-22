import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { integrationSchema } from '@/api/contracts/integrations';
import type * as LoadCapabilities from '@/features/capabilities/load-capabilities';
import { ShopifyPendingGone } from '@/features/capabilities/ShopifyConnect';
import billingMessages from '@/i18n/messages/en/billing.json';
import messages from '@/i18n/messages/en/capabilities.json';

/*
 * ★★ PROD 2026-10-29 09:23:31Z, end to end through the page: Studio ·
 * Capabilities with `pending=1&reason=claim`, the claim answered 200 with no
 * plan page, and the page - revalidated, the cookie spent - read "gone" and
 * said "That approval has expired or was already used".
 *
 * The page runs for real, twice: before the claim with the cookie, after it
 * without. Its banner is mounted from the first tree and replaced in place by
 * the second, as the refresh does. The claim action runs for real against a
 * mocked API.
 */

const jar = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), delete: vi.fn() }));
const post = vi.hoisted(() => vi.fn());
const get = vi.hoisted(() => vi.fn());
const replace = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => jar }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ get, post }) }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('system=shopify&pending=1&reason=claim'),
}));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/i18n/navigation', () => ({
  Link: 'a',
  useRouter: () => ({ replace, refresh: vi.fn() }),
  usePathname: () => '/studio/capabilities',
}));
const loadCapabilities = vi.hoisted(() => vi.fn());
vi.mock('@/features/capabilities/load-capabilities', async (real) => ({
  // The pending read is the real one: it reads the cookie jar above.
  loadShopifyClaim: (await real<typeof LoadCapabilities>()).loadShopifyClaim,
  loadCapabilities,
  loadShopifyAvailability: async () => ({ mode: 'listing', helpUrl: null }),
}));
vi.mock('@/features/billing/load-connector', () => ({ loadShopifyConnector: async () => null }));

const find = <T,>(tree: ReactNode, type: unknown): ReactElement<T> | null => {
  let found: ReactElement<T> | null = null;
  const visit = (node: ReactNode): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!isValidElement(node)) return;
    if (node.type === type) found = node as ReactElement<T>;
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

const PARAMS = { system: 'shopify', pending: '1', reason: 'claim' };
const gone = async () => {
  const { default: Page } = await import('./page');
  const tree = await Page({ searchParams: Promise.resolve(PARAMS) });
  return find<{ read: boolean }>(tree, ShopifyPendingGone);
};
const intl = (node: ReactNode) => (
  <NextIntlClientProvider
    locale="en"
    messages={{ capabilities: messages, billing: billingMessages }}
  >
    {node}
  </NextIntlClientProvider>
);

beforeEach(() => {
  jar.get.mockReset();
  jar.delete.mockReset();
  post.mockReset();
  get.mockReset();
  replace.mockReset();
  loadCapabilities.mockResolvedValue({
    capabilities: [],
    usage: null,
    integrations: [integrationSchema.parse({ id: 'i1', slug: 'shopify', name: 'Shopify' })],
  });
});

/*
 * ★★ App Review 132211: the claim is the layout's prompt, on every page. The
 * Systems page says only "nothing to claim" on `pending=1` - so a claim that
 * worked, re-read without the cookie, is never drawn as "expired" twice.
 */
describe('★★ the real page on pending=1: the prompt is the layout’s; here only "nothing to claim"', () => {
  it('a pending install the server answers: the page draws no banner of its own', async () => {
    jar.get.mockReturnValue({ value: 'p1' });
    get.mockResolvedValue({ shopDomain: 'new.myshopify.com', action: 'attach' });
    expect(await gone()).toBeNull();
  });

  it('no cookie: "expired", with Connect again - never words alone', async () => {
    jar.get.mockReturnValue(undefined);
    const element = await gone();
    expect(element, 'the page drew nothing on pending=1 with nothing to claim').not.toBeNull();
    render(intl(element!));
    expect(screen.getByTestId('shopify-pending-gone')).toHaveTextContent(
      'That approval has expired or was already used',
    );
    expect(screen.getByTestId('shopify-pending-start')).toHaveTextContent('Connect again');
  });
});
