/**
 * Billing to auth notifications.
 *
 * Identity belongs to auth, so billing never mints a credential link or reads
 * an Authentik account itself. It states the commercial facts it owns - which
 * plan, how many credits - and auth decides who to write to and how that
 * person gets in.
 *
 * Fire-and-forget with a bounded timeout, for the same reason `emitBillingEvent`
 * is: this runs inside activation, and a notification outage must never hold
 * money handling open or make a settled payment look unsettled. A missing
 * welcome email is a resend; a wedged activation is a support case.
 */
import { getInternalServiceKey } from "@chatcenter/shared";

const AUTH_URL = process.env.AUTH_SERVICE_URL || "http://auth:4001";
const TIMEOUT_MS = 3_000;

export interface PaymentSucceededNotice {
  tenantId: string;
  tenantName: string;
  planName: string;
  includedCredits: number;
  locale?: string;
  /** A customer-triggered repeat, logged distinctly from the automatic one. */
  resend?: boolean;
}

/** Never throws. The caller has already taken the customer's money. */
export async function notifyPaymentSucceeded(input: PaymentSucceededNotice): Promise<void> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${AUTH_URL}/api/internal/auth/payment-succeeded`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-key": getInternalServiceKey(),
      },
      body: JSON.stringify(input),
      signal: ac.signal,
    });
    if (!res.ok) {
      console.warn(`[billing] payment-succeeded notice refused by auth: HTTP ${res.status}`);
    }
  } catch (err: any) {
    console.warn("[billing] payment-succeeded notice failed:", err?.message ?? err);
  } finally {
    clearTimeout(timer);
  }
}
