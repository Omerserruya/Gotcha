import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PERMISSIONS } from '@/permissions/catalogue';

/** ★★ S1 (Omer, 2026-10-14): Studio has no landing page - it opens the first area one may see. */
const held = vi.hoisted(() => ({
  value: { permissions: [] as string[], status: 'loaded' as 'loaded' | 'unavailable' },
}));
// Recorded, not thrown: what matters is where it was sent.
const redirect = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('next-intl/server', () => ({ getLocale: async () => 'he' }));
vi.mock('@/i18n/navigation', () => ({ redirect }));
vi.mock('@/shell/load-permissions', () => ({
  loadPermissions: async () => ({ ...held.value, roleKey: undefined }),
}));

const { default: Page } = await import('./page');

const landsOn = async (permissions: string[], status: 'loaded' | 'unavailable' = 'loaded') => {
  held.value = { permissions, status };
  redirect.mockClear();
  await Page();
  expect(redirect).toHaveBeenCalledTimes(1);
  return redirect.mock.calls[0]![0] as { href: string; locale: string };
};

beforeEach(() => {
  redirect.mockClear();
});

describe('★★ S1 - /studio opens an area, never a landing page', () => {
  it('★ AI employees first, in the reader’s locale', async () => {
    expect(await landsOn([PERMISSIONS.ai.employees.read, PERMISSIONS.ai.knowledge.read])).toEqual({
      href: '/studio/employees',
      locale: 'he',
    });
  });

  it('★★ one who may not see employees: the first area they may see, in the sidebar’s order', async () => {
    expect((await landsOn([PERMISSIONS.ai.knowledge.read])).href).toBe('/studio/knowledge');
    expect((await landsOn([PERMISSIONS.ai.workflows.read])).href).toBe('/studio/automations');
    expect((await landsOn([PERMISSIONS.ai.tools.read])).href).toBe('/studio/capabilities');
  });

  it('permissions that could not be read gate nothing, as the sidebar: employees', async () => {
    expect((await landsOn([], 'unavailable')).href).toBe('/studio/employees');
  });

  it('none at all: employees, whose page says what it says', async () => {
    expect((await landsOn([])).href).toBe('/studio/employees');
  });
});
