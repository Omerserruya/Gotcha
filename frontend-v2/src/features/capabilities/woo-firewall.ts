import type { Egress, StoreFirewall, StoreProbe } from '@/api/contracts/woo-probe';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ A FIREWALL ANSWERED, NOT THE STORE (store_firewall_challenge, 2026-11-15)
 * ════════════════════════════════════════════════════════════════════════════
 * Some stores sit behind a bot challenge (Cloudflare's, Sucuri's,
 * Imunify360's): GOTCHA's server is stopped before WooCommerce sees the keys.
 * "Keys rejected" sent merchants to make new keys, which never helps. This
 * says what happened and what to change - and only what the probe knows.
 *
 *   Cloudflare + an address    the IP rule (Omer) and the path rule; which
 *                              leads follows `egress.stable` - an address that
 *                              may still change leads with the path rule,
 *                              which survives it (Backend's plugin says the same)
 *   Cloudflare, no address     the path rule only - never a guessed IP
 *   Sucuri / Imunify360 / other   the host or the security plugin: allow
 *                              /wp-json/wc/ - never Cloudflare's steps
 *   the probe could not tell   the same, unnamed
 */

/** The only path opened: WooCommerce's REST API. Pages and checkout stay protected. */
export const WOO_REST_PATH = '/wp-json/wc/';

export type FirewallRule = 'ip' | 'path';

export type FirewallPlan =
  | {
      readonly kind: 'cloudflare';
      /** In the order shown: the first is the one to do. */
      readonly rules: readonly FirewallRule[];
      readonly egress: Egress | null;
    }
  | {
      readonly kind: 'host';
      /** Named when the probe recognised it; `null` says "your host or a security plugin". */
      readonly firewall: Exclude<StoreFirewall, 'cloudflare' | 'other'> | null;
    };

export function firewallPlan(probe: StoreProbe | null): FirewallPlan {
  if (probe?.firewall === 'cloudflare') {
    const egress = probe.egress ?? null;
    if (egress === null) return { kind: 'cloudflare', rules: ['path'], egress: null };
    return { kind: 'cloudflare', rules: egress.stable ? ['ip', 'path'] : ['path', 'ip'], egress };
  }
  const named =
    probe?.firewall === 'sucuri' || probe?.firewall === 'imunify360' ? probe.firewall : null;
  return { kind: 'host', firewall: named };
}

/** Cloudflare's rule field for the addresses: one is "equals", several "is in". */
export function ipCondition(ips: readonly string[]): {
  readonly operator: 'equals' | 'is in';
  readonly value: string;
} {
  return ips.length === 1
    ? { operator: 'equals', value: ips[0]! }
    : { operator: 'is in', value: `{${ips.join(' ')}}` };
}

/** The probe's answer as the screen's state after "Check now". */
export type ProbeState = 'checking' | 'blocked' | 'open' | 'unknown';

export function probeState(probe: StoreProbe | null): Exclude<ProbeState, 'checking'> {
  if (probe === null) return 'unknown';
  if (probe.reachable) return 'open';
  return probe.reason === 'store_firewall_challenge' ? 'blocked' : 'unknown';
}
