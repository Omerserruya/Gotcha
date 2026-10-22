import { assertPublicUrl, getRedis } from "@chatcenter/shared";

/**
 * Does this WooCommerce store have the Shipment Tracking extension?
 *
 * Without it `woocommerce.get_shipment_tracking` can only ever answer "no
 * tracking here", so offering it to the model buys a wasted turn and, worse, a
 * reply about tracking the store does not have. The tool is surfaced only when
 * the extension was SEEN on the store.
 *
 * Seen how: the extension registers the REST namespace `wc-shipment-tracking/v3`,
 * and a WordPress namespace index is public, so `GET /wp-json/<namespace>`
 * answers 200 when it is installed and 404 when it is not. No keys needed.
 *
 * The verdict is cached per store. When nothing is cached the tool is hidden for
 * that turn and the store is probed in the background: no customer turn ever
 * waits on a store's network. Anything other than 200/404 (a timeout, a 5xx) is
 * not a verdict and is not cached.
 */
export const SHIPMENT_TRACKING_TOOL = "woocommerce.get_shipment_tracking";
export const SHIPMENT_TRACKING_NAMESPACE = "wc-shipment-tracking/v3";
export const VERDICT_TTL_SEC = 6 * 60 * 60;
const PROBE_TIMEOUT_MS = 5_000;

function storeKey(storeUrl: string): string | null {
  const s = String(storeUrl ?? "").trim().replace(/\/+$/, "").toLowerCase();
  return s ? `woo:shipment-tracking:${s}` : null;
}

/** The cached verdict: true / false, or null when there is none (or Redis is unreachable). */
export async function shipmentTrackingKnown(storeUrl: string): Promise<boolean | null> {
  const key = storeKey(storeUrl);
  if (!key) return null;
  try {
    const v = await getRedis().get(key);
    return v === "1" ? true : v === "0" ? false : null;
  } catch {
    return null;
  }
}

/** Record a verdict seen elsewhere (the tool's own call answering 200 or 404). */
export async function recordShipmentTracking(storeUrl: string, present: boolean): Promise<void> {
  const key = storeKey(storeUrl);
  if (!key) return;
  try {
    await getRedis().set(key, present ? "1" : "0", "EX", VERDICT_TTL_SEC);
  } catch {
    /* a missed cache write only means one more probe */
  }
}

const inflight = new Set<string>();

/** Ask the store, and cache what it says. Returns the verdict, or null when it gave none. */
export async function probeShipmentTracking(storeUrl: string, fetchImpl: typeof fetch = fetch): Promise<boolean | null> {
  const base = String(storeUrl ?? "").trim().replace(/\/+$/, "");
  if (!base) return null;
  try {
    const url = `${base}/wp-json/${SHIPMENT_TRACKING_NAMESPACE}`;
    await assertPublicUrl(url);
    const res = await fetchImpl(url, { method: "GET", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (res.status !== 200 && res.status !== 404) return null;
    const present = res.status === 200;
    await recordShipmentTracking(base, present);
    return present;
  } catch {
    return null;
  }
}

/**
 * May the tool be offered for this store right now? Only on a cached "present".
 * With nothing cached it starts one background probe and answers no.
 */
export async function shipmentTrackingVisible(storeUrl: string): Promise<boolean> {
  const known = await shipmentTrackingKnown(storeUrl);
  if (known !== null) return known;
  const key = storeKey(storeUrl);
  if (key && !inflight.has(key)) {
    inflight.add(key);
    void probeShipmentTracking(storeUrl).finally(() => inflight.delete(key));
  }
  return false;
}
