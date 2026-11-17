import 'server-only';

import { isIP } from 'node:net';

import { logger } from '@/observability/logger';

/**
 * ★★ WHO IS ASKING, ON EVERY CALL THIS SERVER MAKES FOR A BROWSER (prod,
 * 2026-11-16).
 *
 * frontend-v2 calls the platform from the server: page renders (`serverApi`)
 * and the browser's own API calls (the BFF). Through the public address those
 * calls left through Cloudflare and came back with OUR egress IP as the client,
 * so every user shared one rate-limit bucket. One console tab looping on
 * /he/system then got every merchant's server calls refused with 429.
 *
 * On the internal route (`API_BASE_URL` = the gateway inside the compose
 * network; Backend, 2026-11-16) the gateway trusts `CF-Connecting-IP` from
 * the network (`set_real_ip_from` 10/8, 172.16/12, 192.168/16) and keys
 * `limit_req` on it. So this module sends it, with the browser's address.
 *
 *   - The address is `X-Real-IP` on the request that reached this server.
 *     The gateway sets that header itself, after its own real-ip step, on
 *     every frontend_v2 location. It is never the browser's own
 *     `CF-Connecting-IP` or `X-Forwarded-For`, which a direct hit could set.
 *   - Not an IP, or missing: no header, and a warning. A guess would put
 *     someone in another person's bucket; nothing puts this call in the
 *     server's shared one, which is the bug, so it is logged.
 *   - Off unless `API_FORWARD_CLIENT=on`. Through Cloudflare (today's
 *     public `API_BASE_URL`) the header would be overwritten anyway; the
 *     switch flips with the base URL.
 *
 * `Host` is not here: Node's fetch drops a Host header without a word
 * (measured, Node 22.22). The gateway sees the right host when the base URL
 * names it, e.g. a compose network alias `app.gotcha.co.il` on the gateway.
 */

/** Headers about the client that only this server may set upstream. */
export const CLIENT_FORWARDING_HEADERS = [
  'cf-connecting-ip',
  'x-real-ip',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'forwarded',
] as const;

let warned = false;

export function clientForwarding(
  incoming: { get(name: string): string | null } | null,
  env: { readonly API_FORWARD_CLIENT: 'on' | 'off'; readonly APP_ORIGIN: string },
): Record<string, string> {
  if (env.API_FORWARD_CLIENT !== 'on') return {};
  const origin = new URL(env.APP_ORIGIN);
  const headers: Record<string, string> = {
    'x-forwarded-host': origin.host,
    'x-forwarded-proto': origin.protocol.replace(/:$/, ''),
  };
  const address = incoming?.get('x-real-ip')?.trim() ?? '';
  if (isIP(address) !== 0) {
    headers['cf-connecting-ip'] = address;
  } else if (!warned) {
    // Once per process: a missing header is a deployment fact, not a per-call event.
    warned = true;
    logger.warn('api.client_address_missing', { present: address !== '' });
  }
  return headers;
}

/** For tests: the warning is once per process. */
export function resetClientForwardingWarning(): void {
  warned = false;
}
