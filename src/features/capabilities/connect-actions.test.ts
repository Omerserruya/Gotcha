import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/** At the wire. `serverApi` is mocked: nothing is connected. */
const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ get, post }) }));
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { connectIntegration, startOAuth } from './connect-actions';

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
  it('POST /api/integrations/:slug/connect with { credentials } — the catalogue’s fields only', async () => {
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

  it('Salesforce carries its login host — only one of its two', async () => {
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
    expect(await startOAuth('stripe')).toEqual({ ok: false, reason: 'not_here' });
    expect(get).not.toHaveBeenCalled();
  });

  it('an address that is not https is not followed', async () => {
    get.mockResolvedValue({ url: 'http://app.hubspot.com/oauth' });
    expect(await startOAuth('hubspot')).toEqual({ ok: false, reason: 'failed' });
  });

  it.each([
    [409, undefined, 'needs_store'],
    [403, undefined, 'forbidden'],
    [500, 'hubspot_oauth_not_configured', 'not_configured'],
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
