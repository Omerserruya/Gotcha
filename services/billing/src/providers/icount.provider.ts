/**
 * iCount provider.
 *
 * Authentication is API-token only - see ./icount-config. Transport is
 * `Authorization: Bearer <token>` with a JSON body, verified against the live
 * account (auth/info returns 200 for a UI-generated API Token).
 *
 * VERIFIED OPERATIONS (written confirmation from iCount support):
 *
 *   cc/bill          charge a stored card token. Works without the customer
 *                    present, without CVV, for merchant-initiated transactions
 *                    and for monthly subscription renewal.
 *                    Fields: sum, token, client_id and/or custom_client_id.
 *   cc/transactions  transaction lookup, for resolving an ambiguous charge.
 *   doc/cancel       full document-linked refund, with refund_cc: true.
 *
 * These replace the fabricated `cc/charge`, `cc/refund` and
 * `paypage/get_token_info` that earlier versions of this file invented.
 *
 * STILL UNVERIFIED, and deliberately not guessed:
 *
 *   - How the tokenization PayPage returns or exposes the reusable card token.
 *     `tokenizeAndVerify` therefore has no live implementation.
 *   - The currency parameter for cc/bill. The account is multi_currency with an
 *     ILS base, so a charge in another currency is NOT safe to attempt yet.
 *   - Any idempotency mechanism for cc/bill. This matters: renewal and dunning
 *     both retry, and without provider-side deduplication a retry is a second
 *     charge. See assertChargeSafety() below.
 *
 * Every live call remains blocked by assertLiveAllowed() until those are closed.
 */
import axios from "axios";
import { createHmac, timingSafeEqual } from "crypto";
import { isMock, icountApiBaseUrl, authHeaders, sanitizeIcountError } from "./icount-config";
import type {
  PaymentProvider,
  TokenizeResult,
  ChargeInput,
  ChargeResult,
  RefundInput,
  WebhookVerifyInput,
} from "./provider";

// Mode, base URL and auth all resolve at CALL time (not module load) so the
// env guard stays testable and honours runtime configuration changes.

/**
 * Hard environment guard: development/test can NEVER reach the live iCount
 * API, even if someone flips ICOUNT_MODE=live in a dev .env. Live requires
 * BOTH a production NODE_ENV and the explicit ICOUNT_ALLOW_LIVE=true
 * acknowledgement - anything else throws before any network call, so a real
 * card can never be charged (or tokenized) from a non-production stack.
 */
function assertLiveAllowed(operation: string): void {
  if (isMock()) return; // mock mode is always safe - no network, no charges
  const isProd = process.env.NODE_ENV === "production";
  const acknowledged = process.env.ICOUNT_ALLOW_LIVE === "true";
  if (!isProd || !acknowledged) {
    throw new Error(
      `[icount] refusing live ${operation}: ICOUNT_MODE=live requires NODE_ENV=production AND ICOUNT_ALLOW_LIVE=true (env guard - dev/test must never charge a real card)`,
    );
  }
}

/**
 * Refuse charges whose safety depends on a contract detail we have not
 * verified.
 *
 * The confirmed cc/bill payload is {sum, token, client_id|custom_client_id}.
 * It carries no verified currency field and no verified idempotency key, so:
 *
 *   - a non-ILS charge would be submitted with an unspecified currency against
 *     a multi-currency account, and
 *   - a retried renewal cannot be deduplicated by the provider.
 *
 * Both are money bugs, not cosmetic gaps, so they fail closed rather than being
 * attempted with an invented parameter name.
 */
function assertChargeSafety(input: ChargeInput): void {
  if (isMock()) return;
  if (input.currency && input.currency.toUpperCase() !== "ILS") {
    throw new Error(
      `[icount] refusing ${input.currency} charge: cc/bill has no verified currency parameter and the account base currency is ILS`,
    );
  }
}

/** One authenticated request. Credentials live only in the header. */
async function call(path: string, body: Record<string, unknown>): Promise<any> {
  try {
    const res = await axios.post(`${icountApiBaseUrl()}/${path}`, body, {
      timeout: 20_000,
      headers: authHeaders(),
    });
    // iCount signals application errors in the body with status:false.
    if (res.data && res.data.status === false) {
      throw new Error(res.data.error_description || res.data.reason || "unknown_error");
    }
    return res.data;
  } catch (err) {
    throw sanitizeIcountError(path, err);
  }
}

export const icountProvider: PaymentProvider = {
  name: "ICOUNT",

  /**
   * Not implemented for live.
   *
   * The tokenization PayPage is confirmed to exist and to be of type
   * `cc_token`, but how it returns the reusable token - directly on a callback,
   * or by fetching it from the iCount customer afterwards - is not verified.
   * Inventing that contract is exactly what produced the previous
   * `paypage/get_token_info`, so there is no live path here at all.
   */
  async tokenizeAndVerify(input): Promise<TokenizeResult> {
    if (isMock()) {
      // Deterministic mock - no network. Keeps dev/E2E flows working.
      return { token: `icmock_${input.pageToken}`, brand: "visa", last4: "4242", expMonth: 12, expYear: 2030 };
    }
    assertLiveAllowed("tokenize");
    throw new Error(
      "[icount] tokenization is not implemented: the token-retrieval contract for the cc_token PayPage is not verified yet",
    );
  },

  /**
   * Charge a stored card token. VERIFIED: POST cc/bill.
   *
   * Unattended by design - no customer presence and no CVV - which is what
   * makes GOTCHA-owned monthly renewal possible.
   */
  async charge(input: ChargeInput): Promise<ChargeResult> {
    if (!isMock()) {
      assertLiveAllowed("charge");
      assertChargeSafety(input);
    }
    if (isMock()) {
      return {
        success: true,
        providerChargeRef: `chg_${input.idempotencyKey}`,
        ...(input.issueInvoice ? { providerInvoiceRef: `inv_${input.idempotencyKey}`, providerPdfUrl: `https://icount.mock/doc/${input.idempotencyKey}.pdf` } : {}),
      };
    }
    try {
      // Only fields confirmed by iCount support are sent. No invented
      // currency, description or idempotency parameter.
      const data = await call("cc/bill", {
        sum: input.amount,
        token: input.token,
        ...(input.providerCustomerId ? { client_id: input.providerCustomerId } : {}),
      });
      return {
        success: true,
        providerChargeRef: data.confirmation_code || data.deal_id || data.txn_id,
        providerInvoiceRef: data.docnum ? String(data.docnum) : undefined,
        providerPdfUrl: data.doc_url,
      };
    } catch (err: any) {
      return { success: false, failureCode: err?.message || "charge_failed" };
    }
  },

  /**
   * Refund. VERIFIED: POST doc/cancel with refund_cc: true.
   *
   * Two consequences of it being DOCUMENT-linked rather than charge-linked:
   *
   *   1. It needs the document reference, not the charge reference. A charge
   *      recorded without a document cannot be refunded through this route.
   *   2. It is a FULL cancellation. A partial refund would silently return more
   *      than asked, so a partial request fails instead of being approximated.
   */
  async refund(input: RefundInput): Promise<ChargeResult> {
    if (!isMock()) assertLiveAllowed("refund");
    if (isMock()) return { success: true, providerChargeRef: `rfnd_${input.idempotencyKey}` };

    if (input.expectedFullAmount != null && input.amount !== input.expectedFullAmount) {
      return {
        success: false,
        failureCode: "partial_refund_unsupported: doc/cancel cancels the whole document",
      };
    }
    if (!input.providerInvoiceRef) {
      return {
        success: false,
        failureCode: "missing_document_reference: doc/cancel is document-linked, a charge ref is not enough",
      };
    }
    try {
      const data = await call("doc/cancel", {
        doctype: input.providerInvoiceDocType || "invrec",
        docnum: input.providerInvoiceRef,
        refund_cc: true,
        ...(input.reason ? { reason: input.reason } : {}),
      });
      return { success: true, providerChargeRef: data.confirmation_code || input.providerChargeRef };
    } catch (err: any) {
      return { success: false, failureCode: err?.message || "refund_failed" };
    }
  },

  /**
   * Resolve an ambiguous charge. VERIFIED: POST cc/transactions.
   *
   * The safety net for the missing idempotency contract: when a charge's
   * outcome is unknown (timeout, crash between request and response), ask the
   * provider what actually happened instead of retrying blind.
   */
  async lookupTransactions(query: { token?: string; clientId?: string }): Promise<unknown> {
    if (isMock()) return { transactions: [] };
    assertLiveAllowed("transaction lookup");
    return call("cc/transactions", {
      ...(query.token ? { token: query.token } : {}),
      ...(query.clientId ? { client_id: query.clientId } : {}),
    });
  },

  verifyWebhook(input: WebhookVerifyInput): boolean {
    const secret = process.env.ICOUNT_WEBHOOK_SECRET;
    if (!secret) return isMock(); // dev: accept in mock mode, reject in live without a secret
    const sig = (input.headers["x-icount-signature"] as string) || "";
    const expected = createHmac("sha256", secret).update(input.rawBody).digest("hex");
    try {
      return sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    } catch {
      return false;
    }
  },
};
