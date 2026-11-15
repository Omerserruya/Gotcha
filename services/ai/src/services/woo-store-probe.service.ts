/**
 * "Can GOTCHA reach this store's WooCommerce API?" (Supervisor 2026-11-15,
 * plugin-side diagnosis (a)): asked from our servers, because a Cloudflare
 * challenge depends on the caller's IP (prod 2026-11-15: chanivainberger.co.il
 * and alphamom.co.il challenge prod's IP and answer dev's).
 *
 * Only ever a store the workspace has connected or has just started to
 * connect (rememberPendingStore, an hour): never an address a caller names.
 * One unauthenticated GET of the endpoint the key check uses; WooCommerce's
 * own 401 means it answered. The SSRF guard first, no redirect followed, one
 * probe per store a minute.
 */
import { assertPublicUrl, getRedis, prisma } from "@chatcenter/shared";
import { isFirewallChallenge, firewallOf, normalizeStoreUrl, STORE_FIREWALL_CHALLENGE, type StoreFirewall } from "./connectors/woocommerce.adapter";
import { egressConfig, type Egress } from "../lib/egress";

export type ProbeReason = "reachable" | typeof STORE_FIREWALL_CHALLENGE | "rest_api_not_found" | "redirected" | "timeout" | "unreachable" | `http_${number}`;
export interface ProbeResult { reachable: boolean; reason: ProbeReason; status?: number; firewall?: StoreFirewall; storeUrl: string; checkedAt: string; egress?: Egress | null }

export const PROBE_TIMEOUT_MS = 10_000;
export const PROBE_CACHE_SECONDS = 60;
export const PENDING_STORE_SECONDS = 3600;
const pendingKey = (tenantId: string) => `woo:pending-store:${tenantId}`;
const cacheKey = (storeUrl: string) => `woo:probe:${storeUrl.toLowerCase()}`;

/** The store a workspace has just started connecting (wc-auth init, pasted keys). */
export async function rememberPendingStore(tenantId: string, storeUrl: string): Promise<void> {
  const url = normalizeStoreUrl(storeUrl);
  if (!tenantId || !url) return;
  await getRedis().set(pendingKey(tenantId), url, "EX", PENDING_STORE_SECONDS).catch(() => undefined);
}

/** The one store this workspace may probe: its WooCommerce connection's, else the one it is connecting now. */
export async function storeToProbe(tenantId: string): Promise<string | null> {
  const row = await prisma.tenantIntegration.findFirst({
    where: { tenantId, integration: { slug: "woocommerce" } },
    orderBy: { updatedAt: "desc" },
    select: { config: true },
  }).catch(() => null);
  const connected = normalizeStoreUrl((row?.config as any)?.storeUrl);
  if (connected) return connected;
  const pending = await getRedis().get(pendingKey(tenantId)).catch(() => null);
  return normalizeStoreUrl(pending);
}

/** A blocked answer carries this environment's egress, read now (a config change shows on the next probe). */
function withEgressOf(r: ProbeResult): ProbeResult {
  return r.reason === STORE_FIREWALL_CHALLENGE ? { ...r, egress: egressConfig() } : r;
}

/** Probe a store already chosen by storeToProbe or by a bound plugin site. Never throws. */
export async function probeStore(storeUrl: string, fetchImpl: typeof fetch = fetch): Promise<ProbeResult> {
  const base = normalizeStoreUrl(storeUrl);
  const at = () => new Date().toISOString();
  if (!base) return { reachable: false, reason: "unreachable", storeUrl: String(storeUrl), checkedAt: at() };
  const cached = await getRedis().get(cacheKey(base)).catch(() => null);
  if (cached) { try { return withEgressOf(JSON.parse(cached) as ProbeResult); } catch { /* probe again */ } }
  const url = `${base}/wp-json/wc/v3/system_status`;
  let out: ProbeResult;
  try {
    await assertPublicUrl(url);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    const res = await fetchImpl(url, { headers: { Accept: "application/json" }, redirect: "manual", signal: ctrl.signal });
    clearTimeout(t);
    const body = await res.text().catch(() => "");
    if (isFirewallChallenge(res.status, res.headers, body)) {
      // The addresses to let through (config, this environment's), read on every answer, never cached stale.
      out = { reachable: false, reason: STORE_FIREWALL_CHALLENGE, status: res.status, firewall: firewallOf(res.headers, body), storeUrl: base, checkedAt: at() };
    } else if ((res.status === 401 || res.status === 403 || res.ok) && /"code"\s*:\s*"woocommerce_rest_|"environment"\s*:/.test(body)) {
      out = { reachable: true, reason: "reachable", status: res.status, storeUrl: base, checkedAt: at() };
    } else if (res.status === 404) {
      out = { reachable: false, reason: "rest_api_not_found", status: 404, storeUrl: base, checkedAt: at() };
    } else if (res.status >= 300 && res.status < 400) {
      out = { reachable: false, reason: "redirected", status: res.status, storeUrl: base, checkedAt: at() };
    } else {
      out = { reachable: false, reason: `http_${res.status}`, status: res.status, storeUrl: base, checkedAt: at() };
    }
  } catch (err: any) {
    out = { reachable: false, reason: err?.name === "AbortError" ? "timeout" : "unreachable", storeUrl: base, checkedAt: at() };
  }
  await getRedis().set(cacheKey(base), JSON.stringify(out), "EX", PROBE_CACHE_SECONDS).catch(() => undefined);
  return withEgressOf(out);
}
