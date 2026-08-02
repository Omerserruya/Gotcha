/**
 * A deterministic model of iCount, for end-to-end tests.
 *
 * The reason this exists rather than "just point tests at the sandbox": the
 * paths that matter most in billing are the ones where something goes wrong -
 * a decline mid-renewal, a timeout after the charge was submitted, a response
 * with no reference in it. Those cannot be produced on demand against a real
 * payments API, so the code that handles them would never be exercised.
 *
 * It performs no network calls and holds no credentials. Behaviour is selected
 * by the card token, so a test picks an outcome by choosing which stored card
 * to charge - no global state, no ordering between tests.
 *
 * It is NOT a substitute for verifying the real contract. It models the shapes
 * iCount is documented to return; it cannot discover a field nobody confirmed.
 */
import { IcountApiError, IcountOutcomeUnknown, CURRENCY_ID_ILS } from "./icount-client";
import type { BillInput, BillResult, StoredCardToken } from "./icount-client";

/**
 * Token prefixes that select an outcome.
 *
 * Encoded in the token rather than in test setup so a fixture carries its own
 * behaviour and stays readable at the assertion site.
 */
export const SIM = {
  OK: "simtok_ok",
  DECLINE: "simtok_decline",
  INSUFFICIENT: "simtok_insufficient",
  EXPIRED_CARD: "simtok_expired",
  /** Charge submitted, outcome never learned. The dangerous one. */
  TIMEOUT: "simtok_timeout",
  /** Succeeds, but the response carries no usable reference. */
  NO_REF: "simtok_noref",
  /** Provider rejects the request before touching the card. */
  INVALID: "simtok_invalid",
} as const;

let counter = 0;
/** Monotonic, so simulated references are unique without a clock or randomness. */
function nextRef(prefix: string): string {
  counter += 1;
  return `${prefix}_${String(counter).padStart(8, "0")}`;
}

/** Reset between test files that assert on reference values. */
export function resetSimulator(): void {
  counter = 0;
  store.clear();
}

/** Tokens the simulator believes exist, keyed by custom client id. */
const store = new Map<string, StoredCardToken[]>();

/** Pretend a customer completed the hosted page and a card was stored. */
export function simulateTokenization(customClientId: string, token = `${SIM.OK}_${nextRef("card")}`): StoredCardToken {
  const card: StoredCardToken = { token, last4: "4242", brand: "visa", expMonth: 12, expYear: 2030 };
  store.set(customClientId, [...(store.get(customClientId) ?? []), card]);
  return card;
}

export function simulateGenerateSale(input: { pageId: string; customClientId: string }): { saleUrl: string; raw: unknown } {
  if (!input.pageId) throw new IcountApiError("paypage/generate_sale", "page_id is required");
  const ref = nextRef("sale");
  return {
    saleUrl: `https://simulator.invalid/paypage/${encodeURIComponent(input.pageId)}/${ref}`,
    raw: { status: true, sale_url: `https://simulator.invalid/paypage/${input.pageId}/${ref}` },
  };
}

/**
 * The server-side token pull.
 *
 * Returns empty until `simulateTokenization` has been called, which is the
 * point: it models the real race where a customer has been redirected back but
 * the card is not stored yet, so checkout has to wait rather than assume.
 */
export function simulateGetCcTokens(query: { customClientId?: string; clientId?: string }): StoredCardToken[] {
  const key = query.customClientId ?? query.clientId ?? "";
  return [...(store.get(key) ?? [])];
}

/**
 * Charge a stored token.
 *
 * Enforces the same currency rule as the live client. A simulator that is more
 * permissive than production is worse than none: it certifies code that would
 * fail on the real thing.
 */
export function simulateBill(input: BillInput): BillResult {
  if (input.currencyId !== CURRENCY_ID_ILS) {
    throw new IcountApiError("cc/bill", `refusing currency_id ${input.currencyId}: only ILS charges are enabled`);
  }
  if (!input.clientId && !input.customClientId) {
    throw new IcountApiError("cc/bill", "a client identifier is required");
  }
  const sum = Number(input.sum);
  if (!Number.isFinite(sum) || sum <= 0) {
    throw new IcountApiError("cc/bill", "sum must be a positive amount");
  }

  const token = input.token || "";

  if (token.startsWith(SIM.TIMEOUT)) {
    // The charge WAS submitted. Anything that retries this instead of
    // reconciling will double-charge a customer.
    throw new IcountOutcomeUnknown("cc/bill", "simulated_timeout");
  }
  if (token.startsWith(SIM.INVALID)) {
    throw new IcountApiError("cc/bill", "invalid token");
  }
  if (token.startsWith(SIM.DECLINE)) {
    throw new IcountApiError("cc/bill", "transaction declined by issuer");
  }
  if (token.startsWith(SIM.INSUFFICIENT)) {
    throw new IcountApiError("cc/bill", "insufficient funds");
  }
  if (token.startsWith(SIM.EXPIRED_CARD)) {
    throw new IcountApiError("cc/bill", "card expired");
  }
  if (token.startsWith(SIM.NO_REF)) {
    // Succeeded, but nothing came back that could reconcile or refund it.
    return { chargeRef: null, documentRef: null, documentUrl: null, raw: { status: true } };
  }

  const ref = nextRef("sim");
  return {
    chargeRef: ref,
    documentRef: nextRef("doc"),
    documentUrl: `https://simulator.invalid/doc/${ref}.pdf`,
    raw: { status: true, confirmation_code: ref },
  };
}

/**
 * Transaction lookup.
 *
 * Deliberately returns nothing for a simulated timeout. Reconciliation against
 * a provider that has no record must conclude "not charged" rather than
 * inventing a transaction to make the flow tidy.
 */
export function simulateTransactions(query: { token?: string }): { transactions: Array<Record<string, unknown>> } {
  if (query.token?.startsWith(SIM.TIMEOUT)) return { transactions: [] };
  return { transactions: [] };
}

export function simulateCancel(input: { docNum: string }): { ref: string | null; raw: unknown } {
  if (!input.docNum) throw new IcountApiError("doc/cancel", "docnum is required");
  return { ref: nextRef("rfnd"), raw: { status: true } };
}
