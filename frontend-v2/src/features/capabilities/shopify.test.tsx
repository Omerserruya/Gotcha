import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';
import billingMessages from '@/i18n/messages/en/billing.json';
import messages from '@/i18n/messages/en/capabilities.json';

const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
const jar = vi.hoisted(() => ({ set: vi.fn(), get: vi.fn(), delete: vi.fn() }));
const refresh = vi.hoisted(() => vi.fn());
const replace = vi.hoisted(() => vi.fn());
const search = vi.hoisted(() => ({ value: 'system=shopify&pending=1&reason=claim' }));
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => jar }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ get, post }) }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(search.value) }));
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ refresh, replace }),
  usePathname: () => '/studio/capabilities',
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { claimShopifyInstall, startShopifyInstall, verifyShopifyBilling } from './shopify-actions';
import {
  ShopifyBillingVerify,
  ShopifyConnect,
  ShopifyPending,
  ShopifyPendingGone,
} from './ShopifyConnect';
import { cookieFrom, INTENT_COOKIE } from './shopify-cookies';
import { loadShopifyPending } from './load-capabilities';

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  jar.set.mockReset();
  jar.get.mockReset();
  jar.delete.mockReset();
  refresh.mockReset();
  replace.mockReset();
  search.value = 'system=shopify&pending=1&reason=claim';
});

describe('★★ the intent cookie, read off Set-Cookie', () => {
  it('the named one, its value and Max-Age; a clearing one is none', () => {
    expect(
      cookieFrom(
        ['other=1; Path=/', `${INTENT_COOKIE}=h%3Dx; Max-Age=900; Path=/; HttpOnly; SameSite=Lax`],
        INTENT_COOKIE,
      ),
    ).toEqual({ value: 'h=x', maxAge: 900 });
    expect(cookieFrom([`${INTENT_COOKIE}=; Max-Age=0; Path=/`], INTENT_COOKIE)).toBeNull();
    expect(cookieFrom(['x_gotcha_shopify_intent=v'], INTENT_COOKIE)).toBeNull();
  });
});

describe('★★ start - the intent is handed on to the browser, or nothing opens', () => {
  const answer = (setCookie: string[]) =>
    get.mockImplementation(
      async ({ onResponseHeaders }: { onResponseHeaders?: (h: Headers) => void }) => {
        const headers = new Headers();
        for (const c of setCookie) headers.append('set-cookie', c);
        onResponseHeaders?.(headers);
        return { url: 'https://apps.shopify.com/gotcha', mode: 'listing' };
      },
    );

  it('the redesign flow; the cookie set at /, HttpOnly, Lax, with its age', async () => {
    answer([`${INTENT_COOKIE}=handle1; Max-Age=600; Path=/; HttpOnly`]);
    expect(await startShopifyInstall()).toEqual({
      ok: true,
      url: 'https://apps.shopify.com/gotcha',
    });
    expect((get.mock.calls[0]![0] as { endpoint: { path: string } }).endpoint.path).toBe(
      '/api/connectors/shopify/install/start?flow=redesign_studio',
    );
    expect(jar.set).toHaveBeenCalledWith(INTENT_COOKIE, 'handle1', {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      path: '/',
      maxAge: 600,
    });
  });

  it('onboarding step 2 asks for its own flow, so Shopify returns there; an unknown one is refused', async () => {
    answer([`${INTENT_COOKIE}=handle1; Path=/; HttpOnly`]);
    await startShopifyInstall('onboarding_systems');
    expect((get.mock.calls[0]![0] as { endpoint: { path: string } }).endpoint.path).toBe(
      '/api/connectors/shopify/install/start?flow=onboarding_systems',
    );
    get.mockClear();
    expect(await startShopifyInstall('evil' as never)).toEqual({ ok: false, reason: 'failed' });
    expect(get).not.toHaveBeenCalled();
  });

  it('no intent came back: refused - Shopify would return to a workspace nobody named', async () => {
    answer([]);
    expect(await startShopifyInstall()).toEqual({ ok: false, reason: 'failed' });
    expect(jar.set).not.toHaveBeenCalled();
  });
});

describe('★★ claim - the browser’s pending install, sent on', () => {
  it('replace: true with the cookie; the cookie cleared after', async () => {
    jar.get.mockReturnValue({ value: 'p1' });
    post.mockResolvedValue({ data: { planSelectionUrl: null } });
    expect(await claimShopifyInstall(true)).toEqual({ ok: true, planSelectionUrl: null });
    const call = post.mock.calls[0]![0] as { body: unknown; headers: Record<string, string> };
    expect(call.body).toStrictEqual({ replace: true });
    expect(call.headers.cookie).toBe('gotcha_shopify_pending=p1');
    expect(jar.delete).toHaveBeenCalledWith('gotcha_shopify_pending');
  });

  it('no pending cookie: nothing sent', async () => {
    jar.get.mockReturnValue(undefined);
    expect(await claimShopifyInstall(false)).toEqual({ ok: false, reason: 'gone' });
    expect(post).not.toHaveBeenCalled();
  });

  it('409 another store: named from the refusal’s data', async () => {
    jar.get.mockReturnValue({ value: 'p1' });
    post.mockImplementation(async () => {
      throw new ApiError({
        kind: 'conflict',
        status: 409,
        developerMessage: 'another_store_connected',
        errorData: { currentShopDomain: 'old.myshopify.com' },
      });
    });
    expect(await claimShopifyInstall(false)).toEqual({
      ok: false,
      reason: 'another_store_connected',
      currentShop: 'old.myshopify.com',
    });
  });
});

const intl = (node: React.ReactNode) =>
  render(
    <NextIntlClientProvider
      locale="en"
      messages={{ capabilities: messages, billing: billingMessages }}
    >
      {node}
    </NextIntlClientProvider>,
  );

describe('★★ 10 - Shopify before and after', () => {
  it('not published: a sentence and the help link - no button that does nothing', () => {
    intl(<ShopifyConnect mode="not_published" helpUrl="https://help.example/install" />);
    expect(screen.queryByTestId('shopify-start')).toBeNull();
    expect(screen.getByTestId('shopify-not-published')).toHaveTextContent(
      'Installation starts in Shopify',
    );
    expect(screen.getByTestId('shopify-help')).toHaveAttribute(
      'href',
      'https://help.example/install',
    );
  });

  it('unread: said, no button', () => {
    intl(<ShopifyConnect mode={null} helpUrl={null} />);
    expect(screen.queryByTestId('shopify-start')).toBeNull();
  });

  it('a pending replace: nothing replaced before the press; then claimed with replace', async () => {
    jar.get.mockReturnValue({ value: 'p1' });
    post.mockResolvedValue({ data: { planSelectionUrl: null } });
    intl(<ShopifyPending pending="new.myshopify.com" replace helpUrl={null} />);
    expect(post).not.toHaveBeenCalled();
    expect(screen.getByTestId('shopify-pending')).toHaveTextContent(
      'replacing it disconnects that one',
    );
    await userEvent.click(screen.getByTestId('shopify-claim'));
    expect((post.mock.calls[0]![0] as { body: unknown }).body).toStrictEqual({ replace: true });
    expect(screen.getByTestId('shopify-claimed')).toHaveTextContent(
      'new.myshopify.com is connected.',
    );
  });
});

const another = () =>
  new ApiError({
    kind: 'conflict',
    status: 409,
    developerMessage: 'another_store_connected',
    errorData: { currentShopDomain: 'old.myshopify.com' },
  });

describe('★★ split billing - a store is connected only after GOTCHA Core (Omer, 2026-10-28)', () => {
  it('the server says Core is not paid: no Connect, and the way to Core', () => {
    intl(<ShopifyConnect mode="listing" helpUrl={null} connectAllowed={false} />);
    expect(screen.queryByTestId('shopify-start')).toBeNull();
    expect(screen.getByTestId('shopify-core-first')).toHaveTextContent(
      'Connecting a Shopify store needs an active GOTCHA Core plan first.',
    );
    expect(screen.getByTestId('shopify-core-first-link')).toHaveAttribute(
      'href',
      '/settings/billing/plan',
    );
  });

  it.each([true, null])('allowed (%s) or not said: Connect is offered', (allowed) => {
    intl(<ShopifyConnect mode="listing" helpUrl={null} connectAllowed={allowed} />);
    expect(screen.getByTestId('shopify-start')).toBeInTheDocument();
  });

  it.each([
    [undefined, 'redesign_studio'],
    ['onboarding_systems', 'onboarding_systems'],
  ] as const)('★ Connect asks for its flow (%s → %s): onboarding comes back to onboarding', async (flow, asked) => {
    // No intent cookie comes back, so nothing opens: only the flow asked for is read.
    get.mockImplementation(async () => ({ url: 'https://apps.shopify.com/gotcha' }));
    intl(<ShopifyConnect mode="listing" helpUrl={null} flow={flow} />);
    await userEvent.click(screen.getByTestId('shopify-start'));
    expect((get.mock.calls[0]![0] as { endpoint: { path: string } }).endpoint.path).toBe(
      `/api/connectors/shopify/install/start?flow=${asked}`,
    );
  });

  it('the server refuses with 402 core_plan_required: said as that', async () => {
    get.mockRejectedValue(
      new ApiError({
        kind: 'tenant_inactive',
        status: 402,
        developerMessage: 'core_plan_required',
      }),
    );
    expect(await startShopifyInstall()).toEqual({ ok: false, reason: 'core_plan_required' });
  });

  it('the claim refuses with core_plan_required: said as that, never "gone"', async () => {
    jar.get.mockReturnValue({ value: 'p1' });
    post.mockRejectedValue(
      new ApiError({
        kind: 'tenant_inactive',
        status: 402,
        developerMessage: 'core_plan_required',
      }),
    );
    expect(await claimShopifyInstall(false)).toMatchObject({
      ok: false,
      reason: 'core_plan_required',
    });
  });
});

describe('★★ reason=claim - an App Store install, to this workspace', () => {
  it('asks first; another store here → "Replace it?" naming it, and only then replace: true', async () => {
    jar.get.mockReturnValue({ value: 'p1' });
    intl(<ShopifyPending pending="new.myshopify.com" replace={false} helpUrl={null} />);
    expect(screen.getByTestId('shopify-pending-lead')).toHaveTextContent(
      'You approved new.myshopify.com in Shopify. Connect it to this workspace?',
    );
    post.mockRejectedValueOnce(another());
    await userEvent.click(screen.getByTestId('shopify-claim'));
    expect((post.mock.calls[0]![0] as { body: unknown }).body).toStrictEqual({ replace: false });
    expect(screen.getByTestId('shopify-pending-lead')).toHaveTextContent(
      'Another store is connected here (old.myshopify.com). Replace it?',
    );
    expect(screen.queryByTestId('shopify-claim-problem')).toBeNull();
    post.mockResolvedValueOnce({ data: { planSelectionUrl: null } });
    await userEvent.click(screen.getByTestId('shopify-claim'));
    expect((post.mock.calls[1]![0] as { body: unknown }).body).toStrictEqual({ replace: true });
    expect(screen.getByTestId('shopify-claimed')).toBeInTheDocument();
  });

  it('a plan owed: straight to Shopify’s plan page', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    try {
      jar.get.mockReturnValue({ value: 'p1' });
      post.mockResolvedValue({ data: { planSelectionUrl: 'https://admin.shopify.com/charges/x' } });
      intl(<ShopifyPending pending="new.myshopify.com" replace={false} helpUrl={null} />);
      await userEvent.click(screen.getByTestId('shopify-claim'));
      expect(assign).toHaveBeenCalledWith('https://admin.shopify.com/charges/x');
      expect(refresh).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('★★ billing=verify - only what the server read from Shopify', () => {
  const snapshot = (over: Record<string, unknown> = {}) => ({
    grantsAccess: false,
    requiresPlanSelection: false,
    planSelectionUrl: null,
    shopify: { state: 'ACTIVE', declined: false },
    ...over,
  });

  it('the shop goes as a query, compared not trusted; the outcome is the snapshot’s', async () => {
    post.mockResolvedValue(snapshot({ grantsAccess: true }));
    expect(await verifyShopifyBilling('urban.myshopify.com')).toMatchObject({
      ok: true,
      grantsAccess: true,
      planSelectionUrl: null,
    });
    const call = post.mock.calls[0]![0] as { endpoint: { path: string }; query: unknown };
    expect(call.endpoint.path).toBe('/api/billing/shopify/complete');
    expect(call.query).toEqual({ shop: 'urban.myshopify.com' });
  });

  it('a plan URL only when the server says one is owed', async () => {
    post.mockResolvedValue(snapshot({ planSelectionUrl: 'https://admin.shopify.com/p' }));
    expect(await verifyShopifyBilling(null)).toMatchObject({ planSelectionUrl: null });
  });

  it('502 is "couldn’t reach", not "you didn’t pay"; a mismatch is its own', async () => {
    post.mockRejectedValueOnce(
      new ApiError({
        kind: 'server',
        status: 502,
        developerMessage: 'shopify_verification_failed',
      }),
    );
    expect(await verifyShopifyBilling('a')).toEqual({ ok: false, reason: 'unreachable' });
    post.mockRejectedValueOnce(
      new ApiError({ kind: 'conflict', status: 409, developerMessage: 'shopify_shop_mismatch' }),
    );
    expect(await verifyShopifyBilling('a')).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('the screen: checking, then connected and refreshed - once, not per render', async () => {
    post.mockResolvedValue(snapshot({ grantsAccess: true }));
    intl(<ShopifyBillingVerify shop="urban.myshopify.com" />);
    expect(screen.getByTestId('shopify-billing-checking')).toHaveTextContent(
      'Checking with Shopify…',
    );
    expect(await screen.findByTestId('shopify-billing')).toHaveTextContent('Shopify is connected.');
    expect(refresh).toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('a plan needed: the sentence and Shopify’s page; unreachable: try again asks again', async () => {
    post.mockResolvedValueOnce(
      snapshot({
        requiresPlanSelection: true,
        planSelectionUrl: 'https://admin.shopify.com/p',
        shopify: { state: 'PLAN_SELECTION_REQUIRED' },
      }),
    );
    const one = intl(<ShopifyBillingVerify shop={null} />);
    expect(await screen.findByTestId('shopify-billing-plan')).toHaveAttribute(
      'href',
      'https://admin.shopify.com/p',
    );
    expect(screen.getByTestId('shopify-billing')).toHaveTextContent('choose one');
    one.unmount();

    post.mockRejectedValueOnce(new ApiError({ kind: 'server', status: 502 }));
    intl(<ShopifyBillingVerify shop={null} />);
    expect(await screen.findByTestId('shopify-billing')).toHaveTextContent(
      'We couldn’t reach Shopify',
    );
    post.mockResolvedValueOnce(snapshot({ grantsAccess: true }));
    await userEvent.click(screen.getByTestId('shopify-billing-retry'));
    expect(await screen.findByText('Shopify is connected.')).toBeInTheDocument();
  });
});

describe('★★ measured on dev: an arrival is always said', () => {
  it('pending=1 with nothing to claim: expired, said - and the listing when there is one', () => {
    intl(<ShopifyPendingGone read helpUrl="https://apps.shopify.com/gotcha" />);
    expect(screen.getByTestId('shopify-pending-gone')).toHaveTextContent(
      'That approval has expired or was already used - install GOTCHA again from Shopify.',
    );
    expect(screen.getByTestId('shopify-pending-help')).toHaveAttribute(
      'href',
      'https://apps.shopify.com/gotcha',
    );
  });

  it('a failed check is not "expired"', () => {
    intl(<ShopifyPendingGone read={false} helpUrl={null} />);
    expect(screen.getByTestId('shopify-pending-gone')).not.toHaveTextContent('expired');
    expect(screen.queryByTestId('shopify-pending-help')).toBeNull();
  });

  it('★ billing=verify on a store that needs fixing: "needs reconnecting", not "no store" - and no second Reconnect', async () => {
    post.mockRejectedValue(
      new ApiError({ kind: 'conflict', status: 409, developerMessage: 'shopify_not_connected' }),
    );
    intl(<ShopifyBillingVerify shop="urban.myshopify.com" needsReconnect />);
    expect(await screen.findByTestId('shopify-billing')).toHaveTextContent(
      'Shopify needs reconnecting before its plan can be checked.',
    );
    expect(screen.getByTestId('shopify-billing').querySelector('button')).toBeNull();
  });

  it('…and with no integration at all, "no store connected"', async () => {
    post.mockRejectedValue(
      new ApiError({ kind: 'conflict', status: 409, developerMessage: 'shopify_not_connected' }),
    );
    intl(<ShopifyBillingVerify shop={null} />);
    expect(await screen.findByTestId('shopify-billing')).toHaveTextContent(
      'There’s no Shopify store connected to this workspace.',
    );
  });
});

describe('★★ the pending approval: a shop, gone, or unread - three different sentences', () => {
  it('no cookie: gone, nothing asked; a 404: gone; a 500: unread', async () => {
    jar.get.mockReturnValue(undefined);
    expect(await loadShopifyPending()).toBe('gone');
    expect(get).not.toHaveBeenCalled();
    jar.get.mockReturnValue({ value: 'p1' });
    get.mockRejectedValueOnce(new ApiError({ kind: 'not_found', status: 404 }));
    expect(await loadShopifyPending()).toBe('gone');
    get.mockRejectedValueOnce(new ApiError({ kind: 'server', status: 500 }));
    expect(await loadShopifyPending()).toBeNull();
    get.mockResolvedValueOnce({ shopDomain: 'new.myshopify.com' });
    expect(await loadShopifyPending()).toBe('new.myshopify.com');
  });
});

/*
 * ★★ PROD 2026-10-29 09:23:31Z: a claim that WORKED read "That approval has
 * expired or was already used". The claim spends the cookie and revalidates;
 * the page, still on `pending=1`, read "gone" and swapped the banner. These
 * re-render the banner the way the refresh does - same place, new read.
 */
describe('★★ a claim that worked is never "gone"', () => {
  const at = (pending: string | 'gone' | null) => (
    <NextIntlClientProvider
      locale="en"
      messages={{ capabilities: messages, billing: billingMessages }}
    >
      <ShopifyPending pending={pending} replace={false} helpUrl={null} />
    </NextIntlClientProvider>
  );

  it('ok, no plan page: said, the page leaves pending (other params kept), and the re-read "gone" is never drawn', async () => {
    jar.get.mockReturnValue({ value: 'p1' });
    post.mockResolvedValue({ data: { planSelectionUrl: null } });
    const { rerender } = render(at('new.myshopify.com'));
    await userEvent.click(screen.getByTestId('shopify-claim'));
    expect(replace).toHaveBeenCalledWith('/studio/capabilities?system=shopify');
    expect(refresh).not.toHaveBeenCalled();
    // The revalidated page, without the cookie now.
    rerender(at('gone'));
    expect(screen.getByTestId('shopify-claimed')).toHaveTextContent(
      'new.myshopify.com is connected.',
    );
    expect(screen.queryByTestId('shopify-pending-gone')).toBeNull();
  });

  it('ok, only pending in the URL: back to the bare page', async () => {
    search.value = 'pending=1';
    jar.get.mockReturnValue({ value: 'p1' });
    post.mockResolvedValue({ data: { planSelectionUrl: null } });
    render(at('new.myshopify.com'));
    await userEvent.click(screen.getByTestId('shopify-claim'));
    expect(replace).toHaveBeenCalledWith('/studio/capabilities');
  });

  it('ok, a plan owed: straight to Shopify, and the re-read "gone" is not drawn meanwhile', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    try {
      jar.get.mockReturnValue({ value: 'p1' });
      post.mockResolvedValue({ data: { planSelectionUrl: 'https://admin.shopify.com/charges/x' } });
      const { rerender } = render(at('new.myshopify.com'));
      await userEvent.click(screen.getByTestId('shopify-claim'));
      expect(assign).toHaveBeenCalledWith('https://admin.shopify.com/charges/x');
      expect(replace).not.toHaveBeenCalled();
      rerender(at('gone'));
      expect(screen.queryByTestId('shopify-pending-gone')).toBeNull();
      expect(screen.getByTestId('shopify-claimed')).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('arriving with no approval still says "gone" - and unread says so too', () => {
    const { rerender } = render(at('gone'));
    expect(screen.getByTestId('shopify-pending-gone')).toHaveTextContent(
      'That approval has expired or was already used',
    );
    expect(screen.queryByTestId('shopify-claim')).toBeNull();
    rerender(at(null));
    expect(screen.getByTestId('shopify-pending-gone')).not.toHaveTextContent('expired');
  });

  it('a claim that failed keeps the button: 503 billing_link_failed is tried again with the same approval', async () => {
    jar.get.mockReturnValue({ value: 'p1' });
    post.mockRejectedValueOnce(
      new ApiError({ kind: 'server', status: 503, developerMessage: 'billing_link_failed' }),
    );
    render(at('new.myshopify.com'));
    await userEvent.click(screen.getByTestId('shopify-claim'));
    expect(screen.getByTestId('shopify-claim-problem')).toHaveTextContent(
      "new.myshopify.com wasn't connected - try again.",
    );
    expect(jar.delete).not.toHaveBeenCalled();
    post.mockResolvedValueOnce({ data: { planSelectionUrl: null } });
    await userEvent.click(screen.getByTestId('shopify-claim'));
    expect(post).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('shopify-claimed')).toBeInTheDocument();
  });
});

describe("★★ the claim's answers, by what they mean (Backend 0d35aed8)", () => {
  const refusal = (status: number, code: string) =>
    new ApiError({ kind: status === 409 ? 'conflict' : 'server', status, developerMessage: code });

  it.each([
    [409, 'shop_connected_to_another_workspace', 'shop_connected_to_another_workspace'],
    [409, 'pending_install_already_used', 'gone'],
    [404, 'pending_install_not_found', 'gone'],
    [503, 'billing_link_failed', 'failed'],
    // Not proof the approval is gone: a failure, with the button to try again.
    [409, 'something_new', 'failed'],
  ])('%i %s -> %s', async (status, code, reason) => {
    jar.get.mockReturnValue({ value: 'p1' });
    post.mockRejectedValueOnce(refusal(status, code));
    expect(await claimShopifyInstall(false)).toMatchObject({ ok: false, reason });
  });
});
