import { z } from 'zod';

/**
 * `GET /api/woocommerce-plugin/probe-store` (Backend fb28bd20, e538c635):
 * GOTCHA's servers try the workspace's WooCommerce REST API - the connected
 * store, or the one being connected - and say what answered. Enveloped in
 * `data`. Signed in, connect permission.
 *
 * ★ THE ADDRESS COMES ONLY FROM HERE (and the pasted-keys 422), never from a
 *   URL: a crafted link must not tell a merchant, under GOTCHA's name, which
 *   IP to let through (2026-11-15). Each address is checked as an IP before
 *   it is shown; a malformed one is dropped, never printed.
 */
export const STORE_FIREWALLS = ['cloudflare', 'sucuri', 'imunify360', 'other'] as const;
export type StoreFirewall = (typeof STORE_FIREWALLS)[number];

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
/** IPv6 by its alphabet and shape; `z.ipv6()` is the check. */
const isIp = (value: string) => IPV4.test(value) || z.ipv6().safeParse(value).success;

export const egressSchema = z
  .object({
    ips: z.array(z.string()).catch([]),
    stable: z.boolean().catch(false),
  })
  .transform((e) => ({
    ips: [...new Set(e.ips.map((ip) => ip.trim()).filter(isIp))],
    stable: e.stable,
  }))
  .nullish()
  .catch(null)
  // No address left is no address: the path rule only.
  .transform((e) => (e && e.ips.length > 0 ? e : null));
export type Egress = NonNullable<z.infer<typeof egressSchema>>;

export const storeProbeSchema = z.object({
  reachable: z.boolean(),
  /** `reachable`, `store_firewall_challenge`, `rest_api_not_found`, `redirected`, `timeout`, `unreachable`, `http_<n>`. */
  reason: z.string(),
  firewall: z.enum(STORE_FIREWALLS).optional().catch('other'),
  storeUrl: z.string().nullish().catch(null),
  checkedAt: z.string().nullish().catch(null),
  egress: egressSchema,
});
export type StoreProbe = z.infer<typeof storeProbeSchema>;

export const STORE_FIREWALL_CHALLENGE = 'store_firewall_challenge';
