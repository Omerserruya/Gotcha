/**
 * Does this tenant have a checkout its customer could still complete?
 *
 * Checkouts are billing's table; auth asks billing's internal route instead of
 * reading it (billing architecture-rules.test, 2026-11-01). Null when billing
 * cannot answer: callers decide what an unknown means, and a tenant delete
 * treats it as "yes, refuse".
 */
const BILLING_SERVICE_URL = process.env.BILLING_SERVICE_URL || "http://billing:4009";

export async function hasOpenCheckout(tenantId: string): Promise<boolean | null> {
  try {
    const res = await fetch(`${BILLING_SERVICE_URL}/api/internal/billing/open-checkout/${encodeURIComponent(tenantId)}`, {
      headers: { "X-Internal-Key": process.env.INTERNAL_SERVICE_KEY || "" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body: any = await res.json().catch(() => null);
    return typeof body?.open === "boolean" ? body.open : null;
  } catch {
    return null;
  }
}
