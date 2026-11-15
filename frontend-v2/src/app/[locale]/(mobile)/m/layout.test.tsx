import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ★★ The phone's door has the desktop's gates (layout.tsx says so): two-step
 * sign-in included. Required and not enrolled, the phone draws the enrolment
 * steps, never the tabs.
 */
const get = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('@/auth/session-store', () => ({
  activeSession: async () => ({ sub: 's', sid: 'i', at: 'a', exp: 9e9, abs: 9e9 }),
}));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ get }) }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-gotcha-return-to': '/he/m/inbox' }),
}));
vi.mock('@/i18n/load-messages', () => ({ loadMessages: async () => ({}) }));
vi.mock('@/i18n/navigation', () => ({
  redirect: ({ href }: { href: string }) => {
    throw new Error(`LOCALE REDIRECT ${href}`);
  },
}));
vi.mock('@/support/load-support', () => ({ loadSupport: async () => null }));
vi.mock('@/features/roles/load-person', () => ({ loadViewerId: async () => 'u' }));
const MobileShell = vi.hoisted(() => vi.fn(() => null));
vi.mock('@/shell/mobile/MobileShell', () => ({ MobileShell }));
const MfaGate = vi.hoisted(() => vi.fn(() => null));
vi.mock('@/shell/mfa/MfaGate', () => ({ MfaGate }));
vi.mock('@/shell/mfa/MfaWatch', () => ({ MfaWatch: () => null }));
vi.mock('@/config/env.server', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  serverEnv: () => ({ OIDC_ISSUER: 'https://auth.example.test/application/o/gotcha/' }),
}));

const { default: Layout } = await import('./layout');
const render = () => Layout({ children: null, params: Promise.resolve({ locale: 'he' }) });

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

const answer = (mustEnroll: boolean) =>
  get.mockImplementation(async ({ endpoint }: { endpoint: { path: string } }) => {
    if (endpoint.path === '/api/auth/me')
      return { user: { id: 'u', role: 'ADMIN' }, tenantStatus: 'ACTIVE' };
    if (endpoint.path === '/api/account/mfa-gate')
      return {
        required: true,
        reason: 'tenant_admins',
        enrolled: !mustEnroll,
        hasAuthenticator: false,
        hasRecovery: false,
        mustEnroll,
        identityAvailable: true,
      };
    return { permissions: [], features: [] };
  });

beforeEach(() => {
  get.mockReset();
  MfaGate.mockClear();
  MobileShell.mockClear();
});

describe('★★ the phone: two-step sign-in is a gate too', () => {
  it('required, not enrolled: the enrolment steps, not the tabs', async () => {
    answer(true);
    const tree = await render();
    expect(propsOf(MfaGate, tree)).toMatchObject({
      initial: { reason: 'tenant_admins' },
      authOrigin: 'https://auth.example.test',
    });
    expect(propsOf(MobileShell, tree)).toBeNull();
  });

  it('enrolled: the tabs', async () => {
    answer(false);
    const tree = await render();
    expect(propsOf(MfaGate, tree)).toBeNull();
    expect(propsOf(MobileShell, tree)).not.toBeNull();
  });
});

describe("★★ one person: the phone's layout hands the shell `soleHuman` too (2026-11-15)", () => {
  const me = (workspace: unknown) =>
    get.mockImplementation(async ({ endpoint }: { endpoint: { path: string } }) => {
      if (endpoint.path === '/api/auth/me')
        return { user: { id: 'u', role: 'ADMIN' }, tenantStatus: 'ACTIVE', workspace };
      if (endpoint.path === '/api/account/mfa-gate')
        return { required: false, mustEnroll: false, identityAvailable: true };
      return { permissions: [], features: [] };
    });

  it.each([
    [true, { soleHuman: true }],
    [false, { soleHuman: false }],
    [false, undefined],
  ])('★ soleHuman: %s', async (expected, workspace) => {
    me(workspace);
    const { AppProviders } = await import('@/shell/AppProviders');
    expect(propsOf(AppProviders, await render())?.soleHuman).toBe(expected);
  });
});

describe("★★ the phone's payment gate is drawn as in-app (App Store 3.1.1)", () => {
  it('★ an unpaid workspace: the gate, told it may be inside the app', async () => {
    get.mockImplementation(async ({ endpoint }: { endpoint: { path: string } }) => {
      if (endpoint.path === '/api/auth/me')
        return { user: { id: 'u', role: 'ADMIN' }, tenantStatus: 'PENDING_PAYMENT' };
      if (endpoint.path === '/api/checkout/mine')
        return { data: { checkout: { reference: 'chk_1' } } };
      return { permissions: [], features: [] };
    });
    const { WorkspaceGate } = await import('@/shell/WorkspaceGate');
    expect(propsOf(WorkspaceGate, await render())).toMatchObject({ route: 'payment', inApp: true });
  });
});
