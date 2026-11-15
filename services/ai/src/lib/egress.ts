/**
 * The addresses our store calls leave from (Omer 2026-11-15: a store behind
 * Cloudflare is told to let THIS address through, its primary rule). Config,
 * never code: PUBLIC_EGRESS_IP (one address, or several comma-separated, IPv4
 * or IPv6) and PUBLIC_EGRESS_IP_STABLE ("true" once the address is a static
 * one; until then the merchant is told it may change). Unset or invalid: null,
 * and the merchant gets the path rule only, never a guessed address.
 * Each environment sets its own (prod 2026-11-15: 51.17.184.220, not static).
 */
import net from "net";

export interface Egress { ips: string[]; stable: boolean }

export function egressConfig(env: NodeJS.ProcessEnv = process.env): Egress | null {
  const ips = String(env.PUBLIC_EGRESS_IP ?? "").split(",").map((s) => s.trim()).filter((s) => net.isIP(s) !== 0);
  if (!ips.length) return null;
  return { ips: Array.from(new Set(ips)), stable: String(env.PUBLIC_EGRESS_IP_STABLE ?? "").toLowerCase() === "true" };
}

/** The fix, in plain English, with the IP rule first when there is an address (the client writes its own copy). */
export function firewallFixMessage(egress: Egress | null): string {
  const path = "a WAF custom rule with URI Path starts with /wp-json/wc/, action Skip, skipping all remaining custom rules and Super Bot Fight Mode";
  if (!egress) return `The store's firewall (Cloudflare) blocked GOTCHA before it could check the keys. In Cloudflare, add ${path}. Then connect again.`;
  const ip = egress.ips.length === 1 ? `IP Source Address equals ${egress.ips[0]}` : `IP Source Address is in {${egress.ips.join(" ")}}`;
  return `The store's firewall (Cloudflare) blocked GOTCHA before it could check the keys. In Cloudflare, add a WAF custom rule: ${ip}, action Skip, skipping all remaining custom rules and Super Bot Fight Mode${egress.stable ? "" : " (GOTCHA's address may still change)"}. Or instead, ${path}. Then connect again.`;
}
