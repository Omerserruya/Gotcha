import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';
import messages from '@/i18n/messages/en/capabilities.json';

const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
const jar = vi.hoisted(() => ({ set: vi.fn(), get: vi.fn(), delete: vi.fn() }));
const refresh = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => jar }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ get, post }) }));
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { claimShopifyInstall, startShopifyInstall } from './shopify-actions';
import { ShopifyConnect, ShopifyPending } from './ShopifyConnect';
import { cookieFrom, INTENT_COOKIE } from './shopify-cookies';

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  jar.set.mockReset();
  jar.get.mockReset();
  jar.delete.mockReset();
  refresh.mockReset();
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

describe('★★ start — the intent is handed on to the browser, or nothing opens', () => {
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

  it('no intent came back: refused — Shopify would return to a workspace nobody named', async () => {
    answer([]);
    expect(await startShopifyInstall()).toEqual({ ok: false, reason: 'failed' });
    expect(jar.set).not.toHaveBeenCalled();
  });
});

describe('★★ claim — the browser’s pending install, sent on', () => {
  it('replace: true with the cookie; the cookie cleared after', async () => {
    jar.get.mockReturnValue({ value: 'p1' });
    post.mockResolvedValue({});
    expect(await claimShopifyInstall(true)).toEqual({ ok: true });
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
    <NextIntlClientProvider locale="en" messages={{ capabilities: messages }}>
      {node}
    </NextIntlClientProvider>,
  );

describe('★★ 10 — Shopify before and after', () => {
  it('not published: a sentence and the help link — no button that does nothing', () => {
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
    post.mockResolvedValue({});
    intl(<ShopifyPending shopDomain="new.myshopify.com" replace />);
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
