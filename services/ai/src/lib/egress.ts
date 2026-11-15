/**
 * The addresses our store calls leave from (Omer 2026-11-15: a store behind
 * Cloudflare is told to let THIS address through, its primary rule). Config,
 * never code: PUBLIC_EGRESS_IP (one address, or several comma-separated, IPv4
 * or IPv6) and PUBLIC_EGRESS_IP_STABLE ("true" once the address is a static
 * one; until then the merchant is told it may change). Unset or invalid: null,
 * and the merchant gets the path rule only, never a guessed address.
 * Each environment sets its own (prod since 2026-11-15 13:53Z: the Elastic IP
 * 51.84.227.95, stable; dev 89.138.9.205).
 */
import net from "net";

export interface Egress { ips: string[]; stable: boolean }

export function egressConfig(env: NodeJS.ProcessEnv = process.env): Egress | null {
  const ips = String(env.PUBLIC_EGRESS_IP ?? "").split(",").map((s) => s.trim()).filter((s) => net.isIP(s) !== 0);
  if (!ips.length) return null;
  return { ips: Array.from(new Set(ips)), stable: String(env.PUBLIC_EGRESS_IP_STABLE ?? "").toLowerCase() === "true" };
}

/**
 * The fix, in plain English (the client writes its own copy, in the same
 * order, agreed with Frontend 2026-11-15): a stable address leads with the IP
 * rule, the path rule as the alternative; an address that may still change
 * leads with the path rule (an IP rule would silently stop matching), the IP
 * rule second; no address, the path rule alone.
 */
export function firewallFixMessage(egress: Egress | null): string {
  const head = "The store's firewall (Cloudflare) blocked GOTCHA before it could check the keys. In Cloudflare, add";
  const path = "a WAF custom rule with URI Path starts with /wp-json/wc/, action Skip, skipping all remaining custom rules and Super Bot Fight Mode";
  if (!egress) return `${head} ${path}. Then connect again.`;
  const ipValue = egress.ips.length === 1 ? `IP Source Address equals ${egress.ips[0]}` : `IP Source Address is in {${egress.ips.join(" ")}}`;
  const ip = `a WAF custom rule with ${ipValue}, action Skip, skipping all remaining custom rules and Super Bot Fight Mode`;
  return egress.stable
    ? `${head} ${ip}. Or instead, ${path}. Then connect again.`
    : `${head} ${path}. Or instead, ${ip} (GOTCHA's address may still change). Then connect again.`;
}
