import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { authEndpoints } from '@/api/endpoints/registry';

import { browserApi, SESSION_EXPIRED_EVENT, SUPPORT_ENDED_EVENT } from './browser-api';

/**
 * ★★ The browser hears which session the platform refused: support mode
 * ending is not the sign-in ending, and the two go different ways.
 */
const heard = () => {
  const events: string[] = [];
  for (const name of [SESSION_EXPIRED_EVENT, SUPPORT_ENDED_EVENT]) {
    window.addEventListener(name, () => events.push(name));
  }
  return events;
};
const refuse = (code: string) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ error: 'x', code }), { status: 401 })),
  );
const read = () => browserApi.get({ endpoint: authEndpoints.me(), payload: z.unknown() });

afterEach(() => vi.unstubAllGlobals());

describe('the browser client and a 401', () => {
  it.each(['support_expired', 'support_session_invalid'])(
    '★★ %s: support mode ended - never "your session ended"',
    async (code) => {
      const events = heard();
      refuse(code);
      await expect(read()).rejects.toMatchObject({ status: 401 });
      expect(events).toEqual([SUPPORT_ENDED_EVENT]);
    },
  );

  it('any other 401: the sign-in ended, as before', async () => {
    const events = heard();
    refuse('token_expired');
    await expect(read()).rejects.toMatchObject({ status: 401 });
    expect(events).toEqual([SESSION_EXPIRED_EVENT]);
  });
});
