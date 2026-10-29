import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { integrationSchema } from '@/api/contracts/integrations';
import type * as LoadCapabilities from '@/features/capabilities/load-capabilities';
import { ShopifyPending } from '@/features/capabilities/ShopifyConnect';
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
  loadShopifyPending: (await real<typeof LoadCapabilities>()).loadShopifyPending,
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
const banner = async () => {
  const { default: Page } = await import('./page');
  const tree = await Page({ searchParams: Promise.resolve(PARAMS) });
  const element = find<{ pending: string | 'gone' | null }>(tree, ShopifyPending);
  expect(element, 'the page drew no Shopify banner on pending=1').not.toBeNull();
  return element!;
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

describe('★★ the real page: a claim that worked, then the page read again without the cookie', () => {
  it('no plan page: "connected", the URL leaves pending - never "expired or already used"', async () => {
    // Arrival: the cookie is there, and the pending route names the store.
    jar.get.mockReturnValue({ value: 'p1' });
    get.mockResolvedValue({ shopDomain: 'new.myshopify.com' });
    const before = await banner();
    expect(before.props.pending).toBe('new.myshopify.com');
    const { rerender } = render(intl(before));

    post.mockResolvedValue({ data: { planSelectionUrl: null } });
    await userEvent.click(screen.getByTestId('shopify-claim'));
    expect(jar.delete).toHaveBeenCalledWith('gotcha_shopify_pending');
    expect(replace).toHaveBeenCalledWith('/studio/capabilities?system=shopify');

    // The revalidated page: the cookie is spent, so it reads "gone" - in place of the first.
    jar.get.mockReturnValue(undefined);
    const after = await banner();
    expect(after.props.pending).toBe('gone');
    rerender(intl(after));

    expect(screen.getByTestId('shopify-claimed')).toHaveTextContent(
      'new.myshopify.com is connected.',
    );
    expect(screen.queryByTestId('shopify-pending-gone')).toBeNull();
    expect(document.body).not.toHaveTextContent('expired or was already used');
  });

  it('a page that arrives with no cookie still says "gone"', async () => {
    jar.get.mockReturnValue(undefined);
    render(intl(await banner()));
    expect(screen.getByTestId('shopify-pending-gone')).toHaveTextContent(
      'That approval has expired or was already used',
    );
  });
});
