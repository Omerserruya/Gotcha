import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/** At the wire. `serverApi` is mocked: nothing is connected. */
const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ get, post }) }));
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { connectIntegration, disconnectSystem, startOAuth, startWooOAuth } from './connect-actions';
import { storeAddressOf } from './oauth';

const catalogue = [
  {
    id: 'i1',
    slug: 'paypal',
    name: 'PayPal',
    authType: 'API_KEY',
    authSchema: {
      fields: [
        { key: 'clientId', type: 'password', label: 'Client ID', required: true },
        { key: 'clientSecret', type: 'password', label: 'Client Secret', required: true },
        {
          key: 'environment',
          type: 'select',
          label: 'Environment',
          options: ['live', 'sandbox'],
          required: true,
        },
      ],
    },
  },
  {
    id: 'i2',
    slug: 'hubspot',
    name: 'HubSpot',
    authType: 'OAUTH2',
    authSchema: { oauth: true, fields: [] },
  },
  {
    id: 'i3',
    slug: 'salesforce',
    name: 'Salesforce',
    authType: 'OAUTH2',
    authSchema: {
      oauth: true,
      fields: [
        {
          key: 'loginHost',
          type: 'select',
          label: 'Login Host',
          required: true,
          options: ['https://login.salesforce.com'],
        },
      ],
    },
  },
];

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  get.mockImplementation(async ({ payload }: { payload: { parse: (v: unknown) => unknown } }) =>
    payload.parse(catalogue),
  );
});

describe('★★ Connect at the wire', () => {
  it('POST /api/integrations/:slug/connect with { credentials } - the catalogue’s fields only', async () => {
    post.mockResolvedValue({ id: 'ti1' });
    expect(
      await connectIntegration('paypal', {
        clientId: ' id ',
        clientSecret: 'secret',
        environment: 'sandbox',
        // Not a field the catalogue declares: never sent.
        webhookUrl: 'https://evil.example',
      }),
    ).toEqual({ ok: true });
    const call = post.mock.calls[0]![0] as { endpoint: { path: string }; body: unknown };
    expect(call.endpoint.path).toBe('/api/integrations/paypal/connect');
    expect(call.body).toStrictEqual({
      credentials: { clientId: 'id', clientSecret: 'secret', environment: 'sandbox' },
    });
  });

  it('nothing is posted for OAuth, an unknown system, or a missing field', async () => {
    expect(await connectIntegration('hubspot', {})).toEqual({ ok: false, reason: 'not_here' });
    // OAuth with a field of its own is still OAuth.
    expect(
      await connectIntegration('salesforce', { loginHost: 'https://login.salesforce.com' }),
    ).toEqual({ ok: false, reason: 'not_here' });
    expect(await connectIntegration('nope', {})).toEqual({ ok: false, reason: 'failed' });
    expect(
      await connectIntegration('paypal', { clientId: 'a', clientSecret: '', environment: 'live' }),
    ).toEqual({ ok: false, reason: 'missing' });
    expect(post).not.toHaveBeenCalled();
  });

  it.each([
    [402, 'entitlement'],
    [403, 'forbidden'],
    [400, 'missing'],
    [500, 'failed'],
  ] as const)('%i → %s', async (status, reason) => {
    post.mockImplementation(async () => {
      throw new ApiError({ kind: status === 403 ? 'authorization' : 'server', status });
    });
    expect(
      await connectIntegration('paypal', { clientId: 'a', clientSecret: 'b', environment: 'live' }),
    ).toEqual({ ok: false, reason });
  });
});

describe('★★ OAuth start at the wire (backend 381a5d1b)', () => {
  it('asks for the redesign flow, server-side, and hands back the provider’s https address', async () => {
    get.mockImplementation(async ({ endpoint }: { endpoint: { path: string } }) => {
      expect(endpoint.path).toBe('/api/connectors/hubspot/oauth/init?flow=redesign_studio');
      return { url: 'https://app.hubspot.com/oauth/authorize?state=s' };
    });
    expect(await startOAuth('hubspot')).toEqual({
      ok: true,
      url: 'https://app.hubspot.com/oauth/authorize?state=s',
    });
    expect(post).not.toHaveBeenCalled();
  });

  it('Salesforce carries its login host - only one of its two', async () => {
    get.mockResolvedValue({ url: 'https://test.salesforce.com/services/oauth2/authorize' });
    await startOAuth('salesforce', 'https://test.salesforce.com');
    expect((get.mock.calls[0]![0] as { endpoint: { path: string } }).endpoint.path).toBe(
      `/api/connectors/salesforce/oauth/init?flow=redesign_studio&loginHost=${encodeURIComponent('https://test.salesforce.com')}`,
    );
    get.mockClear();
    expect(await startOAuth('salesforce', 'https://evil.example')).toEqual({
      ok: false,
      reason: 'failed',
    });
    expect(get).not.toHaveBeenCalled();
  });

  it('a system that does not come back here is never started', async () => {
    expect(await startOAuth('wix')).toEqual({ ok: false, reason: 'not_here' });
    expect(get).not.toHaveBeenCalled();
  });

  it.each([
    ['stripe', '/api/connectors/stripe/oauth/init?flow=redesign_studio'],
    ['zoho_crm', '/api/integrations/oauth/zoho_crm/init?flow=redesign_studio'],
    ['google_calendar', '/api/integrations/oauth/google_calendar/init?flow=redesign_studio'],
    ['calendly', '/api/integrations/oauth/calendly/init?flow=redesign_studio'],
  ])('★ %s starts at its own route (e7523379): %s', async (slug, path) => {
    get.mockResolvedValue({ url: 'https://provider.example/authorize' });
    expect(await startOAuth(slug)).toEqual({ ok: true, url: 'https://provider.example/authorize' });
    expect((get.mock.calls.at(-1)![0] as { endpoint: { path: string } }).endpoint.path).toBe(path);
  });

  it('an address that is not https is not followed', async () => {
    get.mockResolvedValue({ url: 'http://app.hubspot.com/oauth' });
    expect(await startOAuth('hubspot')).toEqual({ ok: false, reason: 'failed' });
  });

  it.each([
    [409, undefined, 'needs_store'],
    [403, undefined, 'forbidden'],
    [500, 'hubspot_oauth_not_configured', 'not_configured'],
    // The legacy routes (crm-oauth, calendar-oauth) say it with a space.
    [500, 'Zoho OAuth not configured (set ZOHO_CLIENT_ID + ZOHO_REDIRECT_URI)', 'not_configured'],
    [500, 'Google Calendar OAuth not configured', 'not_configured'],
    [500, 'boom', 'failed'],
  ] as const)('%i %s → %s', async (status, message, reason) => {
    get.mockImplementation(async () => {
      throw new ApiError({
        kind: status === 403 ? 'authorization' : status === 409 ? 'conflict' : 'server',
        status,
        developerMessage: message,
      });
    });
    expect(await startOAuth('shopify')).toEqual({ ok: false, reason });
  });
});

describe('★★ B - the store address, and the start at the wire', () => {
  it.each([
    ['shop.example.com', 'https://shop.example.com'],
    ['https://shop.example.com/', 'https://shop.example.com'],
    ['https://example.com/store/', 'https://example.com/store'],
    ['http://shop.example.com', null],
    ['https://user:pw@shop.example.com', null],
    ['localhost', null],
    ['', null],
    ['javascript:alert(1)', null],
  ])('production: %j → %j', (raw, address) => {
    expect(storeAddressOf(raw, true)).toBe(address);
  });

  it('http only outside production', () => {
    expect(storeAddressOf('http://shop.example.com', false)).toBe('http://shop.example.com');
  });

  it('asks for the redesign flow as JSON with the address; refusals are named', async () => {
    get.mockResolvedValue({ url: 'https://shop.example.com/wc-auth/v1/authorize?a=1' });
    expect(await startWooOAuth('shop.example.com')).toEqual({
      ok: true,
      url: 'https://shop.example.com/wc-auth/v1/authorize?a=1',
    });
    expect((get.mock.calls.at(-1)![0] as { endpoint: { path: string } }).endpoint.path).toBe(
      '/api/integrations/woocommerce/oauth/init?storeUrl=https%3A%2F%2Fshop.example.com&flow=redesign_studio&format=json',
    );
    get.mockClear();
    expect(await startWooOAuth('not a store')).toEqual({ ok: false, reason: 'invalid_store' });
    expect(get).not.toHaveBeenCalled();
    get.mockImplementation(async () => {
      throw new ApiError({
        kind: 'validation',
        status: 400,
        developerMessage: 'invalid_store_url',
      });
    });
    expect(await startWooOAuth('shop.example.com')).toEqual({ ok: false, reason: 'invalid_store' });
  });
});

describe('★★ 1aaaefe4 - 422 from a key form', () => {
  it('carries the backend’s merchant sentence', async () => {
    get.mockResolvedValue([
      {
        id: 'i',
        slug: 'airtable',
        name: 'Airtable',
        authType: 'API_KEY',
        authSchema: { fields: [{ key: 'apiKey', type: 'password', label: 'Key', required: true }] },
      },
    ]);
    post.mockImplementation(async () => {
      throw new ApiError({
        kind: 'validation',
        status: 422,
        developerMessage: 'validation_failed',
        userMessage: ' That key was rejected. ',
      });
    });
    expect(await connectIntegration('airtable', { apiKey: 'x' })).toEqual({
      ok: false,
      reason: 'validation',
      code: null,
      message: 'That key was rejected.',
    });
  });

  it.each([
    ['CREDENTIALS_INVALID', 'credentials_invalid'],
    ['CONNECTION_FAILED', 'connection_failed'],
    // A code this build does not know is no code: the sentence decides.
    ['SOMETHING_NEW', null],
    ['toString', null],
  ] as const)('★ ai 36739bcc: code %s → %s', async (code, said) => {
    get.mockResolvedValue([
      {
        id: 'i',
        slug: 'fireberry',
        name: 'Fireberry',
        authType: 'API_KEY',
        authSchema: { fields: [{ key: 'apiKey', type: 'password', label: 'Key', required: true }] },
      },
    ]);
    post.mockImplementation(async () => {
      throw new ApiError({
        kind: 'validation',
        status: 422,
        code,
        developerMessage: 'validation_failed',
        userMessage: 'The provider rejected these credentials.',
      });
    });
    expect(await connectIntegration('fireberry', { apiKey: 'x' })).toEqual({
      ok: false,
      reason: 'validation',
      code: said,
      message: 'The provider rejected these credentials.',
    });
  });
});

describe('★★ Disconnect at the wire', () => {
  beforeEach(() => {
    post.mockReset();
  });
  /** The client parses the answer with the call's own payload. */
  const answers = (body: unknown) =>
    post.mockImplementation(async ({ payload }: { payload: { parse: (v: unknown) => unknown } }) =>
      payload.parse(body),
    );

  it('POSTs the connectors route - the one that keeps the action settings', async () => {
    answers({ ok: true });
    expect(await disconnectSystem('pipedrive')).toEqual({ ok: true, chatDisabled: false });
    const call = post.mock.calls[0]![0] as { endpoint: { path: string }; raw?: boolean };
    expect(call.endpoint.path).toBe('/api/connectors/pipedrive/disconnect');
    expect(call.raw).toBe(true);
  });

  it('★ ai 9d583f03: Shopify is sent, and says whether its storefront chat went off (mocked - never dev’s store)', async () => {
    answers({ ok: true, chatDisabled: true, billing: 'unchanged' });
    expect(await disconnectSystem('shopify')).toEqual({ ok: true, chatDisabled: true });
    expect((post.mock.calls[0]![0] as { endpoint: { path: string } }).endpoint.path).toBe(
      '/api/connectors/shopify/disconnect',
    );
    answers({ ok: true, chatDisabled: false, billing: 'unchanged' });
    expect(await disconnectSystem('shopify')).toEqual({ ok: true, chatDisabled: false });
    // An unreadable flag claims nothing was turned off.
    answers({ ok: true, chatDisabled: 'yes' });
    expect(await disconnectSystem('shopify')).toEqual({ ok: true, chatDisabled: false });
  });

  it.each(['google_calendar', 'calendly'])(
    '★ ai 547ec625: %s is sent - the route stops every employee’s calendar too',
    async (slug) => {
      answers({ ok: true });
      expect(await disconnectSystem(slug)).toEqual({ ok: true, chatDisabled: false });
      expect((post.mock.calls[0]![0] as { endpoint: { path: string } }).endpoint.path).toBe(
        `/api/connectors/${slug}/disconnect`,
      );
    },
  );

  it.each([
    [403, 'authorization', 'forbidden'],
    [402, 'tenant_inactive', 'inactive'],
    [404, 'not_found', 'failed'],
    [500, 'server', 'failed'],
  ] as const)('%i → %s → said as %s', async (status, kind, reason) => {
    post.mockRejectedValueOnce(new ApiError({ kind, status }));
    expect(await disconnectSystem('pipedrive')).toEqual({ ok: false, reason });
  });
});

describe('★ NOT_CONFIGURED by its code, whatever the words', () => {
  it('a start refused with code NOT_CONFIGURED is "not set up here"', async () => {
    get.mockImplementation(async () => {
      throw new ApiError({ kind: 'server', status: 500, code: 'NOT_CONFIGURED' });
    });
    expect(await startOAuth('zoho_crm')).toEqual({ ok: false, reason: 'not_configured' });
  });

  it('the code outranks the status: a 409 that says NOT_CONFIGURED is not "needs a store"', async () => {
    get.mockImplementation(async () => {
      throw new ApiError({ kind: 'conflict', status: 409, code: 'NOT_CONFIGURED' });
    });
    expect(await startOAuth('shopify')).toEqual({ ok: false, reason: 'not_configured' });
  });
});
