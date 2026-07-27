/**
 * Customer checkout status client.
 *
 * Read-only by construction. There is no "complete checkout" call here because
 * no such endpoint exists: a browser returning from a payment page proves the
 * customer came back, never that they paid.
 */
const API_URL = process.env.NEXT_PUBLIC_API_URL || "";

export type CheckoutStatus =
  | "AWAITING_PAYMENT_SETUP"
  | "PROCESSING"
  | "PAYMENT_REQUIRED"
  | "FAILED"
  | "EXPIRED"
  | "COMPLETED"
  | "MANUAL_REVIEW";

export type CheckoutNextAction =
  | "START_PAYMENT_SETUP"
  | "PAYMENT_SETUP_UNAVAILABLE"
  | "WAIT"
  | "CONTINUE_TO_APP"
  | "REQUEST_NEW_LINK"
  | "CONTACT_SUPPORT";

export interface CheckoutSummary {
  reference: string;
  organizationName: string | null;
  planName: string;
  chatVolumeOptionKey: string | null;
  voiceVolumeOptionKey: string | null;
  includedCredits: number;
  amount: string;
  currency: string;
  billingInterval: string;
  expiresAt: string;
  status: CheckoutStatus;
  nextAction: CheckoutNextAction;
  retryEligible: boolean;
  paymentSetupAvailable: boolean;
}

export class CheckoutUnavailable extends Error {
  constructor(readonly status: number) {
    super(`checkout_unavailable:${status}`);
    this.name = "CheckoutUnavailable";
  }
}

/**
 * Fetch the safe summary.
 *
 * `token` is the continuation token from the emailed link; a signed-in user
 * omits it and is authorized by session instead. Passing neither yields the
 * same 404 as an unknown reference, by design.
 */
export async function getCheckoutStatus(
  reference: string,
  opts: { token?: string | null; authToken?: string | null; signal?: AbortSignal } = {},
): Promise<CheckoutSummary> {
  const qs = opts.token ? `?token=${encodeURIComponent(opts.token)}` : "";
  const res = await fetch(`${API_URL}/api/checkout/${encodeURIComponent(reference)}/status${qs}`, {
    signal: opts.signal,
    headers: {
      Accept: "application/json",
      ...(opts.authToken ? { Authorization: `Bearer ${opts.authToken}` } : {}),
    },
  });
  if (!res.ok) throw new CheckoutUnavailable(res.status);
  const body = await res.json();
  return body.data as CheckoutSummary;
}

/** Which page a status belongs on, so a stale bookmark self-corrects. */
export function pathForStatus(status: CheckoutStatus): string {
  switch (status) {
    case "COMPLETED": return "/checkout/completed";
    case "EXPIRED": return "/checkout/expired";
    case "FAILED": return "/checkout/failed";
    case "PROCESSING": return "/checkout/processing";
    case "MANUAL_REVIEW": return "/checkout/processing";
    case "PAYMENT_REQUIRED":
    case "AWAITING_PAYMENT_SETUP":
    default: return "/checkout/payment-required";
  }
}
