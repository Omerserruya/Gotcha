import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

const get = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ get }) }));
vi.mock('@/features/capabilities/load-capabilities', () => ({
  loadShopifyAvailability: vi.fn(),
}));

import { businessName, loadWidgetAssignment } from './load-website-widget';

beforeEach(() => {
  get.mockReset();
});

describe('who answers the widget, read (§4.1)', () => {
  it('GET /api/website-widget/assignment, through its contract', async () => {
    get.mockImplementation(async ({ payload }: { payload: { parse: (v: unknown) => unknown } }) =>
      payload.parse({
        data: {
          channels: [{ channel: 'WEBCHAT', employee: null, how: 'none', editable: true }],
          employees: [],
        },
      }),
    );
    expect(await loadWidgetAssignment()).toEqual({
      channels: [
        {
          channel: 'WEBCHAT',
          employee: null,
          how: 'none',
          editable: true,
          dedicated: false,
          sharedWith: [],
        },
      ],
      employees: [],
    });
    expect(get.mock.calls[0]![0]).toMatchObject({
      endpoint: { path: '/api/website-widget/assignment' },
      raw: true,
    });
  });

  it('403 is "not an admin"; anything else is "not read" - never an empty choice', async () => {
    get.mockRejectedValueOnce(new ApiError({ kind: 'authorization', status: 403 }));
    expect(await loadWidgetAssignment()).toBe('forbidden');
    get.mockRejectedValueOnce(new ApiError({ kind: 'server', status: 500 }));
    expect(await loadWidgetAssignment()).toBeNull();
  });
});

describe("★ the business's name - the bootstraps' widget.brand rule (Backend ef8ce568)", () => {
  it('the business profile first, else the workspace, trimmed; nothing at all is null', () => {
    const tenant = { name: ' Workspace T ', status: 'ACTIVE' };
    expect(
      businessName({
        tenant,
        businessProfile: { organizationName: ' Urban Supply ', websiteDomain: null },
      }),
    ).toBe('Urban Supply');
    expect(
      businessName({ tenant, businessProfile: { organizationName: '  ', websiteDomain: null } }),
    ).toBe('Workspace T');
    expect(businessName({ tenant, businessProfile: null })).toBe('Workspace T');
    expect(businessName({ tenant: { name: null, status: '' }, businessProfile: null })).toBeNull();
  });
});
