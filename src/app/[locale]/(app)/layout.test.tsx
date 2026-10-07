import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/**
 * ★★ A 401 is "sign in again", never a screen of "couldn't read" (Omer,
 * 2026-10-04). The layout's own read uses the token every page read uses, and
 * every page waits behind it.
 */
const activeSession = vi.hoisted(() => vi.fn());
const get = vi.hoisted(() => vi.fn());
const redirect = vi.hoisted(() =>
  vi.fn((to: string) => {
    throw new Error(`REDIRECT ${to}`);
  }),
);
vi.mock('server-only', () => ({}));
vi.mock('@/auth/session-store', () => ({ activeSession }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ get }) }));
vi.mock('next/navigation', () => ({ redirect }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-gotcha-return-to': '/en/approvals?tab=done' }),
}));
vi.mock('@/i18n/load-messages', () => ({ loadMessages: async () => ({}) }));
vi.mock('@/shell/AppProviders', () => ({ AppProviders: () => null }));
vi.mock('@/shell/AppShell', () => ({ AppShell: () => null }));
const WorkspaceGate = vi.hoisted(() => vi.fn(() => null));
vi.mock('@/shell/WorkspaceGate', () => ({ WorkspaceGate }));
const localeRedirect = vi.hoisted(() =>
  vi.fn(({ href }: { href: string }) => {
    throw new Error(`LOCALE REDIRECT ${href}`);
  }),
);
vi.mock('@/i18n/navigation', () => ({ redirect: localeRedirect }));

const { default: Layout } = await import('./layout');
const render = () => Layout({ children: null, params: Promise.resolve({ locale: 'en' }) });
const SIGN_IN = `REDIRECT /api/auth/login?returnTo=${encodeURIComponent('/en/approvals?tab=done')}`;

beforeEach(() => {
  activeSession.mockReset();
  get.mockReset();
  redirect.mockClear();
  activeSession.mockResolvedValue({ sub: 's', sid: 'i', at: 'a', exp: 9e9, abs: 9e9 });
});

describe('★★ signed out is sign-in, with the way back', () => {
  it('no session (or one the render cannot renew): sign-in, returning here', async () => {
    activeSession.mockResolvedValue(null);
    await expect(render()).rejects.toThrow(SIGN_IN);
  });

  it('★★ the platform refuses the token (401): sign-in - no partial screen', async () => {
    get.mockRejectedValue(new ApiError({ kind: 'authentication', status: 401 }));
    await expect(render()).rejects.toThrow(SIGN_IN);
  });

  it.each([
    [403, 'authorization'],
    [503, 'server'],
  ] as const)(
    'a %i is not signed out: the screen renders, its read marked unavailable',
    async (status, kind) => {
      get.mockRejectedValue(new ApiError({ kind, status }));
      await expect(render()).resolves.toBeTruthy();
      expect(redirect).not.toHaveBeenCalled();
    },
  );
});

/** The gate's props, wherever the layout put it in the tree. */
function gateIn(node: unknown): Record<string, unknown> | null {
  if (!node || typeof node !== 'object') return null;
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (el.type === WorkspaceGate) return el.props ?? null;
  for (const value of Object.values(el.props ?? {})) {
    const hit = Array.isArray(value) ? value.map(gateIn).find(Boolean) : gateIn(value);
    if (hit) return hit;
  }
  return null;
}

describe("★★ onboarding is a gate (Omer, 2026-10-07) - the server's status decides", () => {
  const me = (tenantStatus: string, role = 'ADMIN', setupAdmin?: { name: string }) =>
    get.mockImplementation(async ({ endpoint }: { endpoint: { path: string } }) => {
      if (endpoint.path === '/api/auth/me') {
        return { user: { id: 'u', role }, tenantStatus, ...(setupAdmin ? { setupAdmin } : {}) };
      }
      if (endpoint.path === '/api/checkout/mine')
        return { data: { checkout: { reference: 'chk_1' } } };
      return { permissions: [], features: [] };
    });

  beforeEach(() => {
    WorkspaceGate.mockClear();
    localeRedirect.mockClear();
  });

  it('an admin of a workspace being set up: to onboarding', async () => {
    me('PENDING_ONBOARDING');
    await expect(render()).rejects.toThrow('LOCALE REDIRECT /onboarding');
  });

  it('a member of it: the waiting screen - no shell', async () => {
    me('PENDING_ONBOARDING', 'AGENT');
    expect(gateIn(await render())).toMatchObject({ route: 'waiting', setupAdmin: null });
  });

  it('…naming who is setting it up, when /auth/me does (Backend 776d2bf2)', async () => {
    me('PENDING_ONBOARDING', 'AGENT', { name: 'Maya Levi' });
    expect(gateIn(await render())).toMatchObject({ route: 'waiting', setupAdmin: 'Maya Levi' });
  });

  it('unpaid: payment, at the open checkout', async () => {
    me('PENDING_PAYMENT');
    expect(gateIn(await render())).toMatchObject({
      route: 'payment',
      paymentPath: '/checkout/payment-required?ref=chk_1',
    });
  });

  it('live: the product - no gate, no redirect', async () => {
    me('ACTIVE');
    expect(gateIn(await render())).toBeNull();
    expect(localeRedirect).not.toHaveBeenCalled();
  });

  it('status unread: Retry, not the product', async () => {
    get.mockRejectedValue(new ApiError({ kind: 'server', status: 503 }));
    expect(gateIn(await render())).toMatchObject({ route: 'unavailable' });
  });
});
