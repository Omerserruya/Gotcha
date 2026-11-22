import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { submitSignUp } from './self-signup';

/**
 * ★★ The submit goes from the BROWSER to the gateway's own /api/auth/signup,
 * so the route's five-an-hour-per-address limit counts each visitor, never
 * the container's one egress address.
 */
const fetchMock = vi.fn();
const FORM = { name: ' Maya ', email: ' m@aviv.co ', businessName: ' Aviv ' };

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const answering = (status: number, body: unknown = {}) =>
  fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status }));

describe('★★ submitSignUp (browser)', () => {
  it('★★ POSTs to the gateway root, same-origin, with the trimmed form, the Terms and the honeypot', async () => {
    answering(202, { ok: true });
    expect(await submitSignUp(FORM, 'he', ' קראתי ', '')).toEqual({ kind: 'sent' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/auth/signup');
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin' });
    expect(JSON.parse(String(init.body))).toEqual({
      name: 'Maya',
      email: 'm@aviv.co',
      businessName: 'Aviv',
      terms: true,
      privacy: true,
      locale: 'he',
      capturedText: 'קראתי',
      website: '',
    });
  });

  it.each([
    [429, { error: 'rate_limited' }, { kind: 'rateLimited' }],
    [404, { error: 'signup_disabled' }, { kind: 'closed' }],
    [
      400,
      { error: 'validation', fields: { email: 'invalid' } },
      { kind: 'invalid', field: 'email' },
    ],
    [400, { error: 'validation', fields: { website: 'x' } }, { kind: 'invalid', field: null }],
    [500, {}, { kind: 'failed' }],
  ])('⚠ %i %j reads as %j', async (status, body, want) => {
    answering(status, body);
    expect(await submitSignUp(FORM, 'en', 'x', '')).toEqual(want);
  });

  it('⚠ the network gone: failed, never thrown', async () => {
    fetchMock.mockRejectedValue(new TypeError('offline'));
    expect(await submitSignUp(FORM, 'en', 'x', '')).toEqual({ kind: 'failed' });
  });

  it('★ a body that is not JSON is read by its status alone', async () => {
    fetchMock.mockResolvedValue(new Response('<html>', { status: 202 }));
    expect(await submitSignUp(FORM, 'en', 'x', '')).toEqual({ kind: 'sent' });
  });
});
