import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

const get = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ get }) }));
vi.mock('@/features/capabilities/load-capabilities', () => ({
  loadShopifyAvailability: vi.fn(),
}));

import { businessName, loadWebsiteWidget, loadWidgetAssignment } from './load-website-widget';

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

describe('★ the business name is read through the client as it really behaves (dev, 2026-10-14)', () => {
  it("GET /api/onboarding/status's whole body: organizationName reaches the preview", async () => {
    // The real client unwraps a top-level `data` unless `raw` is set; a read
    // that forgot `raw` failed every time and fell back to the assistant's name.
    const bodies: Record<string, unknown> = {
      '/api/onboarding/status': {
        data: {
          tenant: { name: 'Workspace T', status: 'ACTIVE' },
          businessProfile: { organizationName: 'Urban Supply - GOTCHA Demo', websiteDomain: null },
          coreSystemConnected: null,
          businessProfileCompleted: true,
        },
      },
    };
    get.mockImplementation(
      async ({
        endpoint,
        payload,
        raw,
      }: {
        endpoint: { path: string };
        payload: { parse: (v: unknown) => unknown };
        raw?: boolean;
      }) => {
        const body = bodies[endpoint.path];
        if (body === undefined) throw new Error(`unexpected ${endpoint.path}`);
        const envelope = body as { data?: unknown };
        return payload.parse(!raw && 'data' in envelope ? envelope.data : body);
      },
    );
    const read = await loadWebsiteWidget({ installTab: false });
    expect(read.business).toBe('Urban Supply - GOTCHA Demo');
    expect(read.website).toBeNull();
  });
});

describe("★ the workspace's website comes with the name (the preview's address)", () => {
  it('the business profile websiteDomain, trimmed', async () => {
    get.mockImplementation(
      async ({
        endpoint,
        payload,
        raw,
      }: {
        endpoint: { path: string };
        payload: { parse: (v: unknown) => unknown };
        raw?: boolean;
      }) => {
        if (endpoint.path !== '/api/onboarding/status')
          throw new Error(`unexpected ${endpoint.path}`);
        const body = {
          data: {
            tenant: { name: 'W', status: 'ACTIVE' },
            businessProfile: { organizationName: 'Urban', websiteDomain: ' urban.example ' },
          },
        };
        return payload.parse(raw ? body : body.data);
      },
    );
    const read = await loadWebsiteWidget({ installTab: false });
    expect(read.website).toBe('urban.example');
  });
});
