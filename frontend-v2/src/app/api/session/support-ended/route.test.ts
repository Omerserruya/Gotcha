/*
 * @vitest-environment node
 */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** ★★ Support mode over: its cookie goes, and the console's page for that workspace opens. */
const tenant = vi.hoisted(() => ({
  value: null as string | null,
  locale: null as 'en' | 'he' | null,
}));
vi.mock('@/api/client/credential-surface', () => ({ refuseOnCredentialSurface: () => null }));
vi.mock('@/config/env.server', () => ({ serverEnv: () => ({ APP_ORIGIN: 'https://app.test' }) }));
vi.mock('@/observability/logger', () => ({ logger: { info: vi.fn() } }));
vi.mock('@/support/support-cookie', () => ({
  SUPPORT_COOKIE: 'sup',
  supportTenant: async () => tenant.value,
  supportReturnLocale: async () => tenant.locale,
}));

const { GET } = await import('./route');
const request = () => new NextRequest('https://app.test/api/session/support-ended');

beforeEach(() => {
  tenant.value = null;
  tenant.locale = null;
});

describe('GET /api/session/support-ended', () => {
  it('the workspace from the sealed cookie, "ended", and the cookie cleared', async () => {
    tenant.value = 't 9';
    const response = await GET(request());
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      'https://app.test/system/tenants/t%209?support=ended',
    );
    expect(response.headers.getSetCookie().some((c) => c.startsWith('sup=;'))).toBe(true);
    expect(response.headers.getSetCookie().some((c) => c.startsWith('gotcha_session'))).toBe(false);
  });

  it("★ in the language the admin entered in - the page it leaves is in the workspace's", async () => {
    tenant.value = 't9';
    tenant.locale = 'en';
    const response = await GET(request());
    expect(response.headers.get('location')).toBe(
      'https://app.test/en/system/tenants/t9?support=ended',
    );
    tenant.value = null;
    expect((await GET(request())).headers.get('location')).toBe(
      'https://app.test/en/system/tenants?support=ended',
    );
  });

  it('no workspace to name: the tenants list', async () => {
    const response = await GET(request());
    expect(response.headers.get('location')).toBe('https://app.test/system/tenants?support=ended');
  });
});
