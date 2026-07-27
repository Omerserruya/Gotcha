/**
 * Customer checkout client.
 *
 * Two of these calls mutate, and both are careful about the same thing: they
 * ask the server to look again, and never tell it what happened. There is no
 * "complete checkout" call, because a browser returning from a payment page
 * proves the customer came back and nothing more. Whether they paid is
 * something only the server can establish, by asking the provider.
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

/** What the card is actually debited, and whether that figure is settled. */
export interface CheckoutCharge {
  amount: string;
  currency: string;
  exchangeRate: string;
  /** True once a real charge froze these numbers; false while indicative. */
  settled: boolean;
}

export interface CheckoutSummary {
  reference: string;
  organizationName: string | null;
  planName: string;
  chatVolumeOptionKey: string | null;
  voiceVolumeOptionKey: string | null;
  includedCredits: number;
  amount: string;
  currency: string;
  charge: CheckoutCharge | null;
  billingInterval: string;
  expiresAt: string;
  status: CheckoutStatus;
  nextAction: CheckoutNextAction;
  retryEligible: boolean;
  paymentSetupAvailable: boolean;
  /** Why the last attempt was refused, if one was. Never a raw provider string. */
  declineCategory: string | null;
  /**
   * True when the outcome is genuinely unknown rather than merely in flight.
   *
   * Resolving it needs a provider lookup and possibly a person, so the waiting
   * copy must not promise "a few moments".
   */
  awaitingResolution: boolean;
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

export type AdvancePhase =
  | "AWAITING_CARD"
  | "CHARGING"
  | "PAID"
  | "PAYMENT_FAILED"
  | "NEEDS_ATTENTION";

export interface AdvanceResult {
  phase: AdvancePhase;
  /** A coarse category, never the provider's raw decline string. */
  declineCategory?: string;
}

function authHeaders(opts: { authToken?: string | null }) {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...(opts.authToken ? { Authorization: `Bearer ${opts.authToken}` } : {}),
  };
}

/**
 * Start payment setup and get where to send the customer.
 *
 * The destination comes from the server. Letting the client choose it would be
 * an open redirect into a page that asks for card details.
 */
export async function startPaymentSession(
  reference: string,
  opts: { token?: string | null; authToken?: string | null } = {},
): Promise<{ redirectUrl: string }> {
  const res = await fetch(`${API_URL}/api/checkout/${encodeURIComponent(reference)}/payment-session`, {
    method: "POST",
    headers: authHeaders(opts),
    body: JSON.stringify(opts.token ? { token: opts.token } : {}),
  });
  if (!res.ok) throw new CheckoutUnavailable(res.status);
  return (await res.json()).data;
}

/**
 * Ask the server to re-check and move the checkout forward.
 *
 * Sends no outcome, no transaction id and no success flag - only proof of who
 * is asking. Safe to call repeatedly; that is how the waiting page works.
 */
export async function advanceCheckout(
  reference: string,
  opts: { token?: string | null; authToken?: string | null; signal?: AbortSignal } = {},
): Promise<AdvanceResult> {
  const res = await fetch(`${API_URL}/api/checkout/${encodeURIComponent(reference)}/advance`, {
    method: "POST",
    headers: authHeaders(opts),
    body: JSON.stringify(opts.token ? { token: opts.token } : {}),
    signal: opts.signal,
  });
  if (!res.ok) throw new CheckoutUnavailable(res.status);
  return (await res.json()).data;
}
