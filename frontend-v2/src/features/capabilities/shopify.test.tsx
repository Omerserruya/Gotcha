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
/*
 * The mock parses the answer with the call's own schema, as the real client
 * does - otherwise a contract test checks the fixture, not the schema.
 */
type Call = { payload: { parse: (v: unknown) => unknown }; raw?: boolean };
/* …and unwraps `data` unless `raw`, as http-client does: a missing `raw: true` fails here too. */
const answer = (call: Call, body: unknown) =>
  call.payload.parse(
    !call.raw && typeof body === 'object' && body !== null && 'data' in body
      ? (body as { data: unknown }).data
      : body,
  );
vi.mock('@/api/client/server-api', () => ({
  serverApi: () => ({
    get: async (call: Call) => answer(call, await get(call)),
    post: async (call: Call) => answer(call, await post(call)),
  }),
}));
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

import {
  claimShopifyInstall,
  dismissShopifyPending,
  startShopifyInstall,
  verifyShopifyBilling,
} from './shopify-actions';
import { ShopifyBillingVerify, ShopifyConnect, ShopifyPendingGone } from './ShopifyConnect';
import { cookieFrom, INTENT_COOKIE } from './shopify-cookies';
import { loadShopifyAvailability, loadShopifyClaim } from './load-capabilities';

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
  const answer = (
    setCookie: string[],
    body: Record<string, unknown> = { url: 'https://apps.shopify.com/gotcha', mode: 'listing' },
  ) =>
    get.mockImplementation(
      async ({ onResponseHeaders }: { onResponseHeaders?: (h: Headers) => void }) => {
        const headers = new Headers();
        for (const c of setCookie) headers.append('set-cookie', c);
        onResponseHeaders?.(headers);
        return body;
      },
    );
  const intent = [`${INTENT_COOKIE}=handle1; Path=/; HttpOnly`];

  it.each([
    ['listing', 'https://apps.shopify.com/gotcha'],
    ['reconnect', 'https://old.myshopify.com/admin/oauth/authorize?client_id=x'],
    ['install_link', 'https://admin.shopify.com/oauth/install_custom_app?client_id=x'],
    [undefined, 'https://apps.shopify.com/gotcha'],
  ])('★★ 165bbe05: mode %s is followed like a listing', async (mode, url) => {
    answer(intent, mode === undefined ? { url } : { url, mode });
    expect(await startShopifyInstall()).toEqual({ ok: true, url });
    expect(jar.set).toHaveBeenCalledWith(INTENT_COOKIE, 'handle1', expect.anything());
  });

  it('★★ not_published (url null): said as that - never "couldn’t be opened, try again"', async () => {
    answer(intent, { url: null, mode: 'not_published' });
    expect(await startShopifyInstall()).toEqual({ ok: false, reason: 'not_published' });
    expect(jar.set).not.toHaveBeenCalled();
  });

  it('a mode we do not know, or a url that is not https, is not followed', async () => {
    answer(intent, { url: 'https://example.com/x', mode: 'teleport' });
    expect(await startShopifyInstall()).toEqual({ ok: false, reason: 'failed' });
    answer(intent, { url: 'http://apps.shopify.com/gotcha', mode: 'reconnect' });
    expect(await startShopifyInstall()).toEqual({ ok: false, reason: 'failed' });
  });

  it('the screen: not_published is the sentence and How to install, beside the button that stays', async () => {
    answer(intent, { url: null, mode: 'not_published' });
    intl(<ShopifyConnect helpUrl="https://help.example/install" />);
    await userEvent.click(screen.getByTestId('shopify-start'));
    expect(await screen.findByTestId('shopify-problem')).toHaveTextContent(
      'Installation starts in Shopify',
    );
    expect(screen.getByTestId('shopify-help')).toHaveAttribute(
      'href',
      'https://help.example/install',
    );
    expect(screen.getByTestId('shopify-start')).toBeInTheDocument();
  });

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
    post.mockResolvedValue({ data: { shopDomain: 'new.myshopify.com', planSelectionUrl: null } });
    expect(await claimShopifyInstall(true)).toEqual({
      ok: true,
      planSelectionUrl: null,
      awaitingGrant: false,
    });
    const call = post.mock.calls[0]![0] as { body: unknown; headers: Record<string, string> };
    expect(call.body).toStrictEqual({ replace: true });
    expect(call.headers.cookie).toBe('gotcha_shopify_pending=p1');
    expect(jar.delete).toHaveBeenCalledWith('gotcha_shopify_pending');
  });

  it('no pending cookie: nothing sent', async () => {
    jar.get.mockReturnValue(undefined);
    expect(await claimShopifyInstall(false)).toEqual({ ok: false, reason: 'expired' });
    expect(post).not.toHaveBeenCalled();
  });

  it('409 another store (the older code): replace_required, named from the refusal’s data', async () => {
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
      reason: 'replace_required',
      currentShop: 'old.myshopify.com',
    });
  });

  it('409 replace_required (the draft’s name): named from `current`', async () => {
    jar.get.mockReturnValue({ value: 'p1' });
    post.mockRejectedValueOnce(
      new ApiError({
        kind: 'conflict',
        status: 409,
        developerMessage: 'replace_required',
        errorData: { current: { shopDomain: 'old.myshopify.com', status: 'CONNECTED' } },
      }),
    );
    expect(await claimShopifyInstall(false)).toEqual({
      ok: false,
      reason: 'replace_required',
      currentShop: 'old.myshopify.com',
    });
    expect(jar.delete).not.toHaveBeenCalled();
  });

  it('★ beaecd42: a private store with entitlement manual is connected and awaiting the grant', async () => {
    jar.get.mockReturnValue({ value: 'p1' });
    post.mockResolvedValueOnce({
      data: {
        shopDomain: 's.myshopify.com',
        billingState: 'CUSTOM_APP_AWAITING_GRANT',
        planSelectionUrl: null,
      },
    });
    expect(await claimShopifyInstall(false)).toEqual({
      ok: true,
      planSelectionUrl: null,
      awaitingGrant: true,
    });
    post.mockResolvedValueOnce({
      data: { billingState: 'CUSTOM_APP_GRANTED', planSelectionUrl: null },
    });
    expect(await claimShopifyInstall(false)).toMatchObject({ awaitingGrant: false });
  });

  it('ca1156f9: navigate to data.planSelectionUrl - https only', async () => {
    jar.get.mockReturnValue({ value: 'p1' });
    post.mockResolvedValueOnce({
      data: {
        shopDomain: 'new.myshopify.com',
        reconnected: false,
        flow: 'redesign_studio',
        billingState: 'PLAN_SELECTION_REQUIRED',
        planSelectionUrl: 'https://admin.shopify.com/charges/x',
      },
    });
    expect(await claimShopifyInstall(false)).toEqual({
      ok: true,
      planSelectionUrl: 'https://admin.shopify.com/charges/x',
      awaitingGrant: false,
    });
    post.mockResolvedValueOnce({ data: { planSelectionUrl: 'http://evil.example/' } });
    expect(await claimShopifyInstall(false)).toEqual({
      ok: true,
      planSelectionUrl: null,
      awaitingGrant: false,
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
  it.each(['not_published', null, 'listing'])(
    '★★ App Review 132211: Connect is a real button whatever the listing (%s)',
    (mode) => {
      intl(<ShopifyConnect mode={mode} helpUrl="https://help.example/install" />);
      expect(screen.getByTestId('shopify-start')).toHaveTextContent('Connect Shopify');
      expect(screen.queryByTestId('shopify-not-published')).toBeNull();
    },
  );

  it('★ a store that left: Reconnect, to the same start', async () => {
    get.mockImplementation(async () => ({ url: 'https://apps.shopify.com/gotcha' }));
    intl(<ShopifyConnect reconnect />);
    await userEvent.click(screen.getByTestId('shopify-start'));
    expect(screen.getByTestId('shopify-start')).toHaveTextContent('Reconnect Shopify');
    expect((get.mock.calls[0]![0] as { endpoint: { path: string } }).endpoint.path).toBe(
      '/api/connectors/shopify/install/start?flow=redesign_studio',
    );
  });
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
  ] as const)(
    '★ Connect asks for its flow (%s → %s): onboarding comes back to onboarding',
    async (flow, asked) => {
      // No intent cookie comes back, so nothing opens: only the flow asked for is read.
      get.mockImplementation(async () => ({ url: 'https://apps.shopify.com/gotcha' }));
      intl(<ShopifyConnect mode="listing" helpUrl={null} flow={flow} />);
      await userEvent.click(screen.getByTestId('shopify-start'));
      expect((get.mock.calls[0]![0] as { endpoint: { path: string } }).endpoint.path).toBe(
        `/api/connectors/shopify/install/start?flow=${asked}`,
      );
    },
  );

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
    // ★★ App Review 132211: never words alone - Connect again starts on Shopify's page.
    expect(screen.getByTestId('shopify-pending-start')).toHaveTextContent('Connect again');
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

describe('★★ private apps: mode custom_app_request (2026-11-22)', () => {
  it('Studio’s Connect is the request card - a store held here still reconnects', () => {
    const { unmount } = intl(<ShopifyConnect mode="custom_app_request" customAppRequest={null} />);
    expect(screen.getByTestId('shopify-private-request')).toBeInTheDocument();
    expect(screen.queryByTestId('shopify-start')).toBeNull();
    unmount();
    intl(<ShopifyConnect mode="custom_app_request" customAppRequest={null} reconnect />);
    expect(screen.getByTestId('shopify-start')).toHaveTextContent('Reconnect Shopify');
  });

  it('the availability read brings the request with the mode; any other mode asks nothing more', async () => {
    get.mockResolvedValueOnce({ mode: 'custom_app_request', helpUrl: null });
    get.mockResolvedValueOnce({
      data: { status: 'requested', shopDomain: 's.myshopify.com', requestedAt: null },
      enabled: true,
    });
    expect(await loadShopifyAvailability()).toMatchObject({
      mode: 'custom_app_request',
      customAppRequest: { status: 'requested', shopDomain: 's.myshopify.com' },
    });
    expect((get.mock.calls[1]![0] as { endpoint: { path: string } }).endpoint.path).toBe(
      '/api/connectors/shopify/custom-app/request',
    );
    get.mockClear();
    get.mockResolvedValueOnce({ mode: 'listing', helpUrl: null });
    expect(await loadShopifyAvailability()).toEqual({ mode: 'listing', helpUrl: null });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('a request that cannot be read is undefined - "unread", never "none"', async () => {
    get.mockResolvedValueOnce({ mode: 'custom_app_request', helpUrl: null });
    get.mockRejectedValueOnce(new ApiError({ kind: 'server', status: 500 }));
    expect((await loadShopifyAvailability())?.customAppRequest).toBeUndefined();
  });
});

describe('★★ the pending install, read whole (App Review 132211)', () => {
  it('no cookie: nothing asked; 401, 403, 404: nothing shown; 500: none either, logged', async () => {
    jar.get.mockReturnValue(undefined);
    expect(await loadShopifyClaim()).toBeNull();
    expect(get).not.toHaveBeenCalled();
    jar.get.mockReturnValue({ value: 'p1' });
    for (const status of [401, 403, 404, 500]) {
      get.mockRejectedValueOnce(new ApiError({ kind: 'server', status }));
      expect(await loadShopifyClaim()).toBeNull();
    }
    get.mockResolvedValueOnce({
      shopDomain: 'new.myshopify.com',
      expiresAt: '2026-11-22T12:00:00Z',
      current: { shopDomain: 'old.myshopify.com', status: 'CONNECTED' },
      action: 'replace',
    });
    expect(await loadShopifyClaim()).toMatchObject({
      shopDomain: 'new.myshopify.com',
      action: 'replace',
      current: { shopDomain: 'old.myshopify.com' },
      blockedReason: null,
    });
    const call = get.mock.calls.at(-1)![0] as { headers: Record<string, string> };
    expect(call.headers.cookie).toBe('gotcha_shopify_pending=p1');
  });

  it('★ every app page waits on it: a cookie read that throws is no prompt, never a crash', async () => {
    jar.get.mockImplementation(() => {
      throw new Error('cookies() outside a request');
    });
    await expect(loadShopifyClaim()).resolves.toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it('an action we do not know is no prompt - never a guess', async () => {
    jar.get.mockReturnValue({ value: 'p1' });
    get.mockResolvedValueOnce({ shopDomain: 'new.myshopify.com', action: 'merge' });
    expect(await loadShopifyClaim()).toBeNull();
  });
});

describe("★★ the claim's answers, by what they mean (App Review contract, and the older codes)", () => {
  const refusal = (status: number, code: string) =>
    new ApiError({ kind: status === 409 ? 'conflict' : 'server', status, developerMessage: code });

  it.each([
    [402, 'core_plan_required', 'core_plan_required', false],
    [409, 'held_by_other_workspace', 'held_by_other_workspace', true],
    [409, 'shop_connected_to_another_workspace', 'held_by_other_workspace', true],
    [410, 'expired', 'expired', true],
    [409, 'pending_install_already_used', 'expired', true],
    [404, 'pending_install_not_found', 'expired', true],
    [503, 'billing_unavailable', 'billing_unavailable', false],
    [503, 'billing_link_failed', 'billing_unavailable', false],
    [403, 'forbidden', 'forbidden', false],
    [409, 'custom_app_for_another_workspace', 'custom_app_for_another_workspace', true],
    // Not proof the approval is gone: a failure, with the button to try again.
    [409, 'something_new', 'failed', false],
  ])('%i %s -> %s (cookie dropped: %s)', async (status, code, reason, dropped) => {
    jar.get.mockReturnValue({ value: 'p1' });
    post.mockRejectedValueOnce(refusal(status, code));
    expect(await claimShopifyInstall(false)).toMatchObject({ ok: false, reason });
    expect(jar.delete.mock.calls.length > 0).toBe(dropped);
  });
});

describe('★★ dismiss - Not now, or Cancel on Replace: no store is touched', () => {
  it('posts dismiss with the cookie, and the cookie goes', async () => {
    jar.get.mockReturnValue({ value: 'p1' });
    post.mockResolvedValueOnce(undefined);
    await dismissShopifyPending();
    const call = post.mock.calls[0]![0] as {
      endpoint: { path: string };
      headers: Record<string, string>;
    };
    expect(call.endpoint.path).toBe('/api/connectors/shopify/install/pending/dismiss');
    expect(call.headers.cookie).toBe('gotcha_shopify_pending=p1');
    expect(jar.delete).toHaveBeenCalledWith('gotcha_shopify_pending');
    expect(
      post.mock.calls.some((c) =>
        (c[0] as { endpoint: { path: string } }).endpoint.path.endsWith('/claim'),
      ),
    ).toBe(false);
  });

  it('a failed dismiss still drops the cookie: a dismissed prompt never returns', async () => {
    jar.get.mockReturnValue({ value: 'p1' });
    post.mockRejectedValueOnce(new ApiError({ kind: 'server', status: 500 }));
    await expect(dismissShopifyPending()).resolves.toBeUndefined();
    expect(jar.delete).toHaveBeenCalledWith('gotcha_shopify_pending');
  });
});
