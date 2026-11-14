/*
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ★★ Support mode rides every platform call but the console's: a console
 * route, or a console page, goes out as the admin.
 */
const held = vi.hoisted(() => ({ value: null as { id: string; tenantId: string } | null }));
const page = vi.hoisted(() => ({ at: null as string | null }));
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  headers: async () => ({
    get: (name: string) => (name === 'x-gotcha-return-to' ? page.at : null),
  }),
}));
vi.mock('./support-cookie', () => ({ readSupport: async () => held.value }));

const { supportHeaders } = await import('./support-headers');
const { isConsoleRoute, isSupportDenied, isSupportEnded } = await import('./support-codes');

beforeEach(() => {
  held.value = { id: 'ss1', tenantId: 't9' };
  page.at = '/en/inbox';
});

describe('supportHeaders', () => {
  it('a workspace call carries the session and its workspace', async () => {
    expect(await supportHeaders('/api/conversations')).toEqual({
      'x-support-session': 'ss1',
      'x-tenant-id': 't9',
    });
  });

  it('no live session: nothing', async () => {
    held.value = null;
    expect(await supportHeaders('/api/conversations')).toEqual({});
  });

  it.each(['/api/system/support-sessions', '/api/system/tenants/{tenantId}', '/api/admin/coupons'])(
    '★★ a console route (%s) goes out as the admin',
    async (route) => {
      expect(await supportHeaders(route)).toEqual({});
    },
  );

  it.each(['/system', '/he/system/tenants/t9', '/en/system/coupons?x=1'])(
    '★★ on a console page (%s) even a workspace route goes out as the admin',
    async (at) => {
      page.at = at;
      expect(await supportHeaders('/api/auth/me')).toEqual({});
    },
  );

  it('a page that only starts like the console is not it', async () => {
    page.at = '/en/systems';
    expect(await supportHeaders('/api/auth/me')).toEqual({
      'x-support-session': 'ss1',
      'x-tenant-id': 't9',
    });
  });

  it('no page (a route handler): the route alone decides', async () => {
    page.at = null;
    expect(await supportHeaders(undefined)).toEqual({
      'x-support-session': 'ss1',
      'x-tenant-id': 't9',
    });
  });
});

describe('support codes', () => {
  it('a console route is /api/system or /api/admin, nothing that only starts like them', () => {
    expect(isConsoleRoute('/api/system')).toBe(true);
    expect(isConsoleRoute('/api/systems')).toBe(false);
    expect(isConsoleRoute('/api/administrators')).toBe(false);
    expect(isConsoleRoute('/api/auth/me')).toBe(false);
  });

  it('★ any support_denied:* is a refusal, the four and one not yet named', () => {
    for (const code of ['billing', 'delete', 'ownership', 'secrets', 'later']) {
      expect(isSupportDenied(`support_denied:${code}`)).toBe(true);
    }
    expect(isSupportDenied('forbidden')).toBe(false);
    expect(isSupportDenied(undefined)).toBe(false);
  });

  it('only the two support 401s end support mode; any other is the sign-in', () => {
    expect(isSupportEnded('support_expired')).toBe(true);
    expect(isSupportEnded('support_session_invalid')).toBe(true);
    expect(isSupportEnded('token_expired')).toBe(false);
    expect(isSupportEnded(undefined)).toBe(false);
  });
});
