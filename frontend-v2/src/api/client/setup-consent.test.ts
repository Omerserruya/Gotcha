import { afterEach, describe, expect, it, vi } from 'vitest';

import { readSetupAccept } from '../contracts/setup-consent';
import { acceptSetupTerms } from './setup-consent';

/**
 * The acceptance, against the answers Backend wrote down for
 * `POST /api/auth/setup/:token/accept` (2026-10-26). `fetch` is stubbed;
 * nothing here records a consent or mints a token.
 */
const BODY = {
  terms: true,
  privacy: true,
  locale: 'he',
  capturedText: 'קראתי ואישרתי את תנאי השירות ואת מדיניות הפרטיות',
} as const;

afterEach(() => vi.unstubAllGlobals());

const answer = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe('acceptSetupTerms', () => {
  it("POSTs the body as JSON to the gateway root, the token escaped, with the page's own cookies", async () => {
    const fetchStub = answer(200, {
      data: { status: 'recovery', flow: 'gotcha-recovery', flowToken: 'tok_1' },
    });
    vi.stubGlobal('fetch', fetchStub);
    const outcome = await acceptSetupTerms('a/b c', BODY);
    expect(outcome).toEqual({ kind: 'recovery', flow: 'gotcha-recovery', flowToken: 'tok_1' });
    const [url, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/auth/setup/a%2Fb%20c/accept');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(JSON.parse(init.body as string)).toEqual(BODY);
  });

  it('a network failure is "unreachable", never a refusal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('offline'))),
    );
    expect(await acceptSetupTerms('tok', BODY)).toEqual({ kind: 'unreachable' });
  });

  it('a body that is not JSON is read by its status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>', { status: 502 })),
    );
    expect(await acceptSetupTerms('tok', BODY)).toEqual({ kind: 'unreachable' });
  });
});

describe('readSetupAccept', () => {
  it.each([
    [
      200,
      { data: { status: 'already_has_password', next: 'https://elsewhere.test/' } },
      'hasPassword',
    ],
    [200, { data: { status: 'expired', reason: 'revoked' } }, 'expired'],
    [400, { error: 'consent_required' }, 'refused'],
    [404, null, 'refused'],
    [429, null, 'unreachable'],
    [503, { error: 'idp_unavailable' }, 'unreachable'],
    [200, { data: { status: 'recovery', flow: 'gotcha-recovery' } }, 'refused'],
    [200, { data: { status: 'something_new' } }, 'refused'],
    [200, null, 'refused'],
  ])('%i %j is %s', (status, body, kind) => {
    expect(readSetupAccept(status, body).kind).toBe(kind);
  });

  it('★ `next` is not carried: the screen offers its own sign-in', () => {
    expect(
      readSetupAccept(200, {
        data: { status: 'already_has_password', next: 'https://elsewhere.test/' },
      }),
    ).toEqual({ kind: 'hasPassword' });
  });
});
