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
/* Where the request is: the proxy's return-to header. A test may move it. */
const at = vi.hoisted(() => ({ path: '/en/approvals?tab=done' }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-gotcha-return-to': at.path }),
}));
vi.mock('@/i18n/load-messages', () => ({ loadMessages: async () => ({}) }));
const AppProviders = vi.hoisted(() => vi.fn(() => null));
vi.mock('@/shell/AppProviders', () => ({ AppProviders }));
const AppShellMock = vi.hoisted(() => vi.fn(() => null));
vi.mock('@/shell/AppShell', () => ({ AppShell: AppShellMock }));
const WorkspaceGate = vi.hoisted(() => vi.fn(() => null));
vi.mock('@/shell/WorkspaceGate', () => ({ WorkspaceGate }));
const localeRedirect = vi.hoisted(() =>
  vi.fn(({ href }: { href: string }) => {
    throw new Error(`LOCALE REDIRECT ${href}`);
  }),
);
vi.mock('@/i18n/navigation', () => ({ redirect: localeRedirect }));
/* Support mode: none unless a test opens one. */
const support = vi.hoisted(() => ({ value: null as Record<string, unknown> | null }));
vi.mock('@/support/load-support', () => ({ loadSupport: async () => support.value }));
const WithSupportBanner = vi.hoisted(() => vi.fn(() => null));
vi.mock('@/features/support/SupportBanner', () => ({ WithSupportBanner }));

/* The MFA gate: drawn instead of the product; the issuer's origin is the frame's. */
const MfaGate = vi.hoisted(() => vi.fn(() => null));
vi.mock('@/shell/mfa/MfaGate', () => ({ MfaGate }));
vi.mock('@/shell/mfa/MfaWatch', () => ({ MfaWatch: () => null }));
vi.mock('@/config/env.server', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  serverEnv: () => ({ OIDC_ISSUER: 'https://auth.example.test/application/o/gotcha/' }),
}));

const { default: Layout } = await import('./layout');
const render = () => Layout({ children: null, params: Promise.resolve({ locale: 'en' }) });
const SIGN_IN = `REDIRECT /api/auth/login?returnTo=${encodeURIComponent('/en/approvals?tab=done')}`;

beforeEach(() => {
  support.value = null;
  at.path = '/en/approvals?tab=done';
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

/** One component's props, wherever the layout put it in the tree. */
function propsOf(type: unknown, node: unknown): Record<string, unknown> | null {
  if (!node || typeof node !== 'object') return null;
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (el.type === type) return el.props ?? null;
  for (const value of Object.values(el.props ?? {})) {
    const hit = Array.isArray(value)
      ? value.map((v) => propsOf(type, v)).find(Boolean)
      : propsOf(type, value);
    if (hit) return hit;
  }
  return null;
}

/** The gate's props, wherever the layout put it in the tree. */
const gateIn = (node: unknown) => propsOf(WorkspaceGate, node);

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
      paymentPath: '/en/checkout/payment-required?ref=chk_1',
    });
  });

  it('unpaid, in Hebrew: the Hebrew checkout page', async () => {
    me('PENDING_PAYMENT');
    const he = await Layout({ children: null, params: Promise.resolve({ locale: 'he' }) });
    expect(gateIn(he)).toMatchObject({ paymentPath: '/he/checkout/payment-required?ref=chk_1' });
  });

  it('live: the product - no gate, no redirect', async () => {
    me('ACTIVE');
    expect(gateIn(await render())).toBeNull();
    expect(localeRedirect).not.toHaveBeenCalled();
  });

  /*
   * ★★ PROD HOTFIX (2026-10-23): admin@, a SYSTEM_ADMIN whose home tenant
   * "System" is PENDING_ADMIN_SETUP, read "your workspace is still being set
   * up". A system admin passes the gate whatever the status.
   */
  it.each([
    ['PENDING_ADMIN_SETUP'],
    ['PENDING_ONBOARDING'],
    ['PENDING_PAYMENT'],
    ['SUSPENDED'],
    ['SOMETHING_NEW'],
    ['ACTIVE'],
  ])(
    '★★ a SYSTEM_ADMIN in a %s tenant: through the gate - never "being set up"',
    async (status) => {
      me(status, 'SYSTEM_ADMIN');
      at.path = '/en/system/tenants';
      expect(gateIn(await render())).toBeNull();
      expect(localeRedirect).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['/he/home'],
    ['/en/inbox'],
    ['/en/settings/billing'],
    ['/en/systems'],
    ['/en/studio/automations'],
  ])('★★ a SYSTEM_ADMIN of a tenant not live: %s goes to the console', async (path) => {
    me('PENDING_ADMIN_SETUP', 'SYSTEM_ADMIN');
    at.path = path;
    await expect(render()).rejects.toThrow('LOCALE REDIRECT /system');
  });

  it('…and the console stays put, with a console-only rail', async () => {
    me('PENDING_ADMIN_SETUP', 'SYSTEM_ADMIN');
    for (const path of ['/en/system', '/he/system/tenants', '/en/system/coupons?x=1']) {
      at.path = path;
      const tree = await render();
      expect(gateIn(tree)).toBeNull();
      expect(propsOf(AppShellMock, tree)).toMatchObject({ consoleOnly: true });
    }
    expect(localeRedirect).not.toHaveBeenCalled();
  });

  it('a SYSTEM_ADMIN of a LIVE tenant uses the product: no redirect, the whole rail', async () => {
    me('ACTIVE', 'SYSTEM_ADMIN');
    at.path = '/en/home';
    const tree = await render();
    expect(gateIn(tree)).toBeNull();
    expect(propsOf(AppShellMock, tree)).toMatchObject({ consoleOnly: false });
    expect(localeRedirect).not.toHaveBeenCalled();
  });

  it('an ADMIN in setup still goes to onboarding, and its Home is not the console', async () => {
    me('PENDING_ADMIN_SETUP');
    at.path = '/en/home';
    await expect(render()).rejects.toThrow('LOCALE REDIRECT /onboarding');
  });

  it('status unread: Retry, not the product', async () => {
    get.mockRejectedValue(new ApiError({ kind: 'server', status: 503 }));
    expect(gateIn(await render())).toMatchObject({ route: 'unavailable' });
  });
});

describe('★★ the realtime socket is for the workspace /auth/me names (2026-10-11)', () => {
  /*
   * The session's `tid` slot is filled by no sign-in, so a layout that read
   * only it handed the provider `null`: no ticket, no socket, and every new
   * message waited for a reload.
   */
  const me = (user: Record<string, unknown>) =>
    get.mockImplementation(async ({ endpoint }: { endpoint: { path: string } }) =>
      endpoint.path === '/api/auth/me'
        ? { user: { id: 'u', role: 'ADMIN', ...user }, tenantStatus: 'ACTIVE' }
        : { permissions: [], features: [] },
    );

  it('a session with no tenant: the providers get the one /auth/me names', async () => {
    me({ tenantId: 'cms4ug98n0004chmrp4lv6ujl' });
    expect(propsOf(AppProviders, await render())).toMatchObject({
      tenantId: 'cms4ug98n0004chmrp4lv6ujl',
    });
  });

  it('/auth/me naming none: null, never an empty string', async () => {
    me({ tenantId: '' });
    expect(propsOf(AppProviders, await render())).toMatchObject({ tenantId: null });
  });

  it('★★ support mode: the providers carry the session, and the shell sits under the banner', async () => {
    me({ tenantId: 't9' });
    support.value = { tenantName: 'Aviv & Co.', reason: 'r', endsAt: '16:40' };
    const tree = await render();
    expect(propsOf(AppProviders, tree)).toMatchObject({ support: support.value });
    // The shell is inside the banner's wrapper (its props are a node to search).
    const banner = propsOf(WithSupportBanner, tree);
    expect(banner).not.toBeNull();
    expect(propsOf(AppShellMock, { props: banner })).not.toBeNull();
  });

  it('outside support mode: no session in the providers', async () => {
    me({ tenantId: 't9' });
    expect(propsOf(AppProviders, await render())).toMatchObject({ support: null });
  });
});

describe('★★ two-step sign-in is a gate (Omer, 2026-11-09; the legacy MfaEnrollmentGate)', () => {
  const gate = (over: Record<string, unknown> = {}) => ({
    required: true,
    reason: 'system_admin',
    enrolled: false,
    hasAuthenticator: false,
    hasRecovery: false,
    mustEnroll: true,
    identityAvailable: true,
    ...over,
  });
  const reads: string[] = [];
  const answer = (mfa: unknown) =>
    get.mockImplementation(async ({ endpoint }: { endpoint: { path: string } }) => {
      reads.push(endpoint.path);
      if (endpoint.path === '/api/auth/me')
        return { user: { id: 'u', role: 'SYSTEM_ADMIN' }, tenantStatus: 'ACTIVE' };
      if (endpoint.path === '/api/account/mfa-gate') {
        if (mfa instanceof Error) throw mfa;
        return mfa;
      }
      return { permissions: [], features: [] };
    });

  beforeEach(() => {
    reads.length = 0;
    MfaGate.mockClear();
    AppShellMock.mockClear();
  });

  it('★★ required, not enrolled: the gate INSTEAD of the product - and no other platform read', async () => {
    answer(gate());
    at.path = '/en/system/tenants';
    const tree = await render();
    expect(propsOf(MfaGate, tree)).toMatchObject({
      initial: { mustEnroll: true, reason: 'system_admin' },
      authOrigin: 'https://auth.example.test',
    });
    expect(propsOf(AppShellMock, tree)).toBeNull();
    // Every other route answers 403 mfa_enrollment_required until it is done.
    expect(reads).toEqual(['/api/auth/me', '/api/account/mfa-gate']);
  });

  it('enrolled, or not required: the product', async () => {
    for (const over of [
      { mustEnroll: false, enrolled: true },
      { required: false, mustEnroll: false },
    ]) {
      answer(gate(over));
      const tree = await render();
      expect(propsOf(MfaGate, tree)).toBeNull();
      expect(propsOf(AppShellMock, tree)).not.toBeNull();
    }
  });

  it('the gate unread: the product, as the legacy gate - the platform’s 403 still holds', async () => {
    answer(new ApiError({ kind: 'server', status: 503 }));
    const tree = await render();
    expect(propsOf(MfaGate, tree)).toBeNull();
    expect(propsOf(AppShellMock, tree)).not.toBeNull();
  });
});
