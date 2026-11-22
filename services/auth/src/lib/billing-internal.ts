/**
 * Internal calls to the billing service.
 *
 * Neither function throws: each returns a verdict, because a billing outage
 * must be reported as a failure by the caller, never swallowed into a tenant
 * with no billing state.
 */
const BILLING_SERVICE_URL = process.env.BILLING_SERVICE_URL || "http://billing:4009";

/** Internal GET against the billing service. Never throws. */
export async function callBillingGet(path: string): Promise<{ ok: boolean; body: any }> {
  try {
    const res = await fetch(`${BILLING_SERVICE_URL}/api/internal/billing/${path}`, {
      headers: { "X-Internal-Key": process.env.INTERNAL_SERVICE_KEY || "" },
      signal: AbortSignal.timeout(15_000),
    });
    return { ok: res.ok, body: await res.json().catch(() => ({})) };
  } catch (err: any) {
    return { ok: false, body: { error: "billing_unreachable", message: err?.message } };
  }
}

/** One internal call to the billing service. Never throws; returns a verdict. */
export async function callBilling(
  path: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; body: any }> {
  try {
    const res = await fetch(`${BILLING_SERVICE_URL}/api/internal/billing/${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Key": process.env.INTERNAL_SERVICE_KEY || "",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const parsed = await res.json().catch(() => ({}));
    return { ok: res.ok, body: parsed };
  } catch (err: any) {
    // A billing outage must not silently produce a tenant with no billing
    // state, so this is reported as a failure rather than swallowed.
    return { ok: false, body: { error: "billing_unreachable", message: err?.message } };
  }
}
