import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { fireEvent, render, screen } from '@testing-library/react';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';
import common from '@/i18n/messages/en/common.json';
import consoleEn from '@/i18n/messages/en/console.json';
import navigation from '@/i18n/messages/en/navigation.json';

/**
 * ★★ Prod, 2026-11-16: one console tab asked for /he/system 4-5 times a
 * second for an hour. Every ask was a server render that called
 * /api/permissions/me, and the platform's rate limit then refused every
 * customer's server calls (they all leave from one address). Whatever the
 * browser does, a permissions/me that answers 429 or 5xx must give the
 * console ONE ordinary page: "couldn't check your access", with a Try again a
 * person presses. Never a 404, never a redirect, never a reload.
 *
 * The door and the permissions read here are the real ones; only the
 * platform call is mocked.
 */
const get = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ get }) }));
vi.mock('@/observability/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const nav = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  redirect: vi.fn(() => {
    throw new Error('NEXT_REDIRECT');
  }),
  refresh: vi.fn(),
  replace: vi.fn(),
  push: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  notFound: nav.notFound,
  redirect: nav.redirect,
  useRouter: () => ({ refresh: nav.refresh, replace: nav.replace, push: nav.push }),
}));
const messages = { console: consoleEn, navigation, common };
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages, namespace: namespace as 'console' }),
}));
vi.mock('@/i18n/navigation', () => ({
  usePathname: () => '/system',
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { requireConsole } = await import('@/shell/require-console');
const { default: Layout } = await import('./layout');
const { default: Home } = await import('./page');

const answers = (outcome: 'system_admin' | 'owner' | 429 | 503 | 500) => {
  get.mockReset();
  if (typeof outcome === 'number') {
    get.mockRejectedValue(
      new ApiError({ kind: outcome === 429 ? 'rate_limited' : 'server', status: outcome }),
    );
  } else {
    get.mockResolvedValue({ permissions: [], features: [], roleKey: outcome });
  }
};

const show = (node: ReactNode) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {node}
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  nav.notFound.mockClear();
  nav.redirect.mockClear();
  nav.refresh.mockClear();
  nav.replace.mockClear();
  nav.push.mockClear();
});

describe('★★ permissions/me answers 429 (or 5xx): the console says so, once', () => {
  it.each([429, 503, 500] as const)('%s: the door answers "unread", never not-found', async (status) => {
    answers(status);
    await expect(requireConsole()).resolves.toBe('unread');
    expect(get).toHaveBeenCalledTimes(1);
    expect(nav.notFound).not.toHaveBeenCalled();
    expect(nav.redirect).not.toHaveBeenCalled();
  });

  it('★★ the layout draws "couldn’t check your access" and a Try again, not the console', async () => {
    answers(429);
    show(await Layout({ children: <p data-testid="inside">tenants</p> }));
    expect(screen.getByTestId('console-unread')).toHaveTextContent("Couldn't open the console");
    expect(screen.queryByTestId('inside')).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Console' })).toBeNull();
    expect(screen.getByTestId('console-retry')).toHaveTextContent('Try again');
  });

  it('★★ and nothing asks again on its own: no refresh, no navigation, until a person presses', async () => {
    vi.useFakeTimers();
    try {
      answers(429);
      show(await Layout({ children: <p>tenants</p> }));
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(nav.refresh).not.toHaveBeenCalled();
      expect(nav.replace).not.toHaveBeenCalled();
      expect(nav.push).not.toHaveBeenCalled();
      expect(get).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByTestId('console-retry'));
      expect(nav.refresh).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('★ the page behind it reads nothing and draws nothing', async () => {
    answers(429);
    await expect(Home()).resolves.toBeNull();
  });

  it('★ a role that WAS read and is not SYSTEM_ADMIN is still not found', async () => {
    answers('owner');
    await expect(requireConsole()).rejects.toThrow('NEXT_NOT_FOUND');
    await expect(Layout({ children: <p>secret</p> })).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('★ a system admin gets the console', async () => {
    answers('system_admin');
    await expect(requireConsole()).resolves.toBe('open');
    show(await Layout({ children: <p data-testid="inside">tenants</p> }));
    expect(screen.getByTestId('inside')).toBeInTheDocument();
  });
});

describe('★★ every console page waits for an open door before it reads', () => {
  const here = join(process.cwd(), 'src/app/[locale]/(app)/system/');
  const pages = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? pages(join(dir, entry.name))
        : entry.name === 'page.tsx'
          ? [join(dir, entry.name)]
          : [],
    );
  const found = pages(here);

  it('finds the pages (a walk that finds none would pass everything below)', () => {
    expect(found.length).toBeGreaterThanOrEqual(7);
  });

  it.each(found.map((path) => [path.slice(here.length) || 'page.tsx', path]))('%s', (_name, path) => {
    const body = readFileSync(path, 'utf8');
    const fn = body.slice(body.indexOf('export default async function'));
    const firstAwait = fn.indexOf('await ');
    expect(fn.slice(firstAwait - 6, firstAwait + 60)).toContain(
      "if ((await requireConsole()) !== 'open') return null;",
    );
  });
});
