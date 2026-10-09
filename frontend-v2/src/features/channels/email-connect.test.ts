import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Email connect through the REAL client against a stubbed `fetch`.
 *
 * The defect was in the parse: the route answers `{ data: [account] }`, the
 * client unwraps `data` to an array, and the action read it as one account -
 * so every connect that worked said "failed". A mocked `serverApi` returning
 * an object would have passed on the broken code; only the wire shape shows it.
 */

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: async () => {} }));
vi.mock('@/api/client/server-api', async () => {
  const { HttpClient } = await import('@/api/client/http-client');
  return { serverApi: () => new HttpClient({ baseUrl: '', defaultTimeoutMs: 1_000 }) };
});

import { connectEmail } from './actions';

const account = {
  id: 'ca-email-1',
  tenantId: 't1',
  channel: 'EMAIL',
  externalId: 'support@shop.example',
  displayName: 'Support',
  credentials: 'enc:opaque',
  connectionStatus: 'CONNECTED',
  isActive: true,
  connectedAt: '2026-10-09T08:00:00.000Z',
};

const respond = (status: number, body: unknown) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  );

const input = {
  emailAddress: 'support@shop.example',
  displayName: 'Support',
  smtpHost: 'smtp.shop.example',
  smtpPort: 587,
  smtpUser: 'support@shop.example',
  smtpPass: 'secret',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('★★ POST /api/channels/connect/email answers { data: [account] }', () => {
  it('the route’s real answer is a success, with the account it made', async () => {
    respond(200, { data: [account] });
    const result = await connectEmail(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.id).toBe('ca-email-1');
    expect(result.data.channel).toBe('EMAIL');
    expect(result.data.connectionStatus).toBe('CONNECTED');
  });

  it('a bare account is a success too', async () => {
    respond(200, { data: account });
    const result = await connectEmail(input);
    expect(result.ok && result.data.id).toBe('ca-email-1');
  });

  it('an empty list is not a connected mailbox', async () => {
    respond(200, { data: [] });
    expect(await connectEmail(input)).toEqual({ ok: false, reason: 'failed' });
  });

  it('409 is "already connected", not "failed"', async () => {
    respond(409, { error: 'This email address is already connected' });
    expect(await connectEmail(input)).toEqual({ ok: false, reason: 'duplicate' });
  });
});
