import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { authEndpoints } from '@/api/endpoints/registry';

import { browserApi } from './browser-api';

/**
 * ★ The browser asks in the INTERFACE language, not its own: a Hebrew screen
 * in an English browser is Hebrew. The page's `<html lang>`; the BFF passes
 * the header on to the platform.
 */
const sentHeaders = async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  await browserApi.get({
    endpoint: authEndpoints.me(),
    payload: z.object({ data: z.array(z.unknown()) }),
    raw: true,
  });
  return (fetch.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<
    string,
    string
  >;
};

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.lang = '';
});

describe('★ browser calls carry the page’s language', () => {
  it('Accept-Language is <html lang>', async () => {
    document.documentElement.lang = 'he';
    expect((await sentHeaders())['accept-language']).toBe('he');
  });

  it('no lang on the page: no header (the browser’s own is left as it is)', async () => {
    expect(await sentHeaders()).not.toHaveProperty('accept-language');
  });
});
