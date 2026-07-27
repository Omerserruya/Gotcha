/**
 * iCount provider.
 *
 * Authentication is API-token only - see ./icount-config. The wire-level calls
 * live in ./icount-client, one typed function per verified operation; this file
 * is the policy layer that decides whether a call may happen at all.
 *
 * VERIFIED OPERATIONS (written confirmation from iCount support):
 *
 *   paypage/generate_sale  create a hosted tokenization session -> sale_url
 *   client/get_cc_tokens   server-side pull of the stored card token
 *   cc/bill                charge a stored token: sum, token, client_id,
 *                          currency_id (1 = ILS)
 *   cc/transactions        transaction lookup, for reconciling an UNKNOWN
 *   doc/cancel             full document-linked refund, with refund_cc: true
 *
 * The token-retrieval gap that previously kept checkout disabled is closed:
 * `client/get_cc_tokens` means the server can establish that a card was stored
 * without ever trusting a browser redirect as evidence.
 *
 * What has NOT changed: cc/bill still has no provider-side idempotency. A
 * retried charge is a second charge. GOTCHA's own uniqueness constraints and
 * cc/transactions reconciliation remain the only double-charge guards, which is
 * why an unknown outcome is never retried.
 */
import { createHmac, timingSafeEqual } from "crypto";
import { isMock, isSimulator, icountMode } from "./icount-config";
import * as api from "./icount-client";
import { CURRENCY_ID_ILS, IcountOutcomeUnknown } from "./icount-client";
import * as sim from "./icount-simulator";
import type {
  PaymentProvider,
  TokenizeResult,
  ChargeInput,
  ChargeResult,
  RefundInput,
  WebhookVerifyInput,
  StartTokenizationInput,
  StartTokenizationResult,
  StoredCardQuery,
} from "./provider";

export { IcountOutcomeUnknown };

/**
 * Hard environment guard: development and test can NEVER reach the live iCount
 * API, even if someone flips ICOUNT_MODE=live in a dev .env. Live requires BOTH
 * a production NODE_ENV and the explicit ICOUNT_ALLOW_LIVE=true acknowledgement,
 * checked before any network call - so a real card cannot be charged from a
 * non-production stack.
 */
function assertLiveAllowed(operation: string): void {
  if (isMock()) return;
  const isProd = process.env.NODE_ENV === "production";
  const acknowledged = process.env.ICOUNT_ALLOW_LIVE === "true";
  if (!isProd || !acknowledged) {
    throw new Error(
      `[icount] refusing live ${operation}: ICOUNT_MODE=live requires NODE_ENV=production AND ICOUNT_ALLOW_LIVE=true (env guard - dev/test must never charge a real card)`,
    );
  }
}

/**
 * Everything that must hold before an amount is submitted.
 *
 * The currency check is the one that earns its place. The account is
 * multi-currency, so a charge with the wrong currency id does not fail - it
 * succeeds for the wrong amount, and the customer finds out on their statement.
 */
function assertChargeSafety(input: ChargeInput): void {
  const currency = (input.chargeCurrency || input.currency || "").toUpperCase();
  if (currency !== "ILS") {
    throw new Error(`[icount] refusing a ${currency || "(unspecified)"} charge: only ILS charges are enabled`);
  }
  if (input.providerCurrencyId !== CURRENCY_ID_ILS) {
    throw new Error(
      `[icount] refusing charge with currency_id ${input.providerCurrencyId}: ILS charges must be submitted as currency_id ${CURRENCY_ID_ILS}`,
    );
  }
  if (!input.chargeAmount || Number(input.chargeAmount) <= 0) {
    throw new Error("[icount] refusing charge: no positive charge amount was supplied");
  }
  if (!input.providerCustomerId && !input.customClientId) {
    throw new Error("[icount] refusing charge: no client identifier - the charge could not be attributed");
  }
}

export const icountProvider: PaymentProvider = {
  name: "ICOUNT",

  /**
   * Read the configured payment page, so its type can be checked.
   *
   * Mock and simulator report a correctly configured page: they perform no
   * network call, and there is no real page to misconfigure.
   */
  async describePaymentPage(pageId: string) {
    if (isMock()) return { doctype: "cc_token", hk_page: 0, is_active: 1, is_deleted: 0 };
    assertLiveAllowed("payment page lookup");
    return api.paypageInfo(pageId);
  },

  /**
   * Create the hosted page session the customer is sent to.
   *
   * Returns a URL and nothing else. The success and failure URLs are where the
   * browser lands, not how the outcome is learned.
   */
  async startTokenization(input: StartTokenizationInput): Promise<StartTokenizationResult> {
    if (isSimulator()) {
      return sim.simulateGenerateSale({ pageId: input.pageId, customClientId: input.customClientId });
    }
    if (isMock()) {
      // Mock models a customer who pays immediately and successfully: the card
      // appears the moment they are sent to the page.
      //
      // It has to be registered HERE rather than returned unconditionally from
      // listStoredCards, because the baseline is captured before this call. A
      // mock that always returned a card would put that card in the baseline
      // too, so nothing would ever look new and a local checkout could never
      // complete - which is precisely what it did before this.
      sim.simulateTokenization(input.customClientId, `icmock_${input.customClientId}`);
      return {
        saleUrl: `https://icount.mock/paypage/${encodeURIComponent(input.pageId)}?ref=${encodeURIComponent(input.customClientId)}`,
        raw: { mock: true },
      };
    }
    assertLiveAllowed("tokenization session");
    return api.generateSale(input);
  },

  /**
   * Ask the provider which cards it has stored for this customer.
   *
   * The only accepted proof of tokenization. A customer arriving back on the
   * success URL proves they returned; this proves a card exists.
   */
  async listStoredCards(query: StoredCardQuery) {
    // Mock and simulator share the same store, so both answer honestly: no
    // cards for a customer reference nobody has tokenized, exactly as a real
    // provider does.
    if (isMock()) return sim.simulateGetCcTokens(query);
    assertLiveAllowed("stored card lookup");
    return api.getCcTokens(query);
  },

  /** Legacy shim. Tokenization is established by pulling the card, not by a redirect. */
  async tokenizeAndVerify(input): Promise<TokenizeResult> {
    if (isMock()) {
      return { token: `icmock_${input.pageToken}`, brand: "visa", last4: "4242", expMonth: 12, expYear: 2030 };
    }
    assertLiveAllowed("tokenize");
    throw new Error(
      "[icount] tokenizeAndVerify is not the tokenization path - use startTokenization then listStoredCards, which establishes the card server-side",
    );
  },

  /**
   * Charge a stored card token in ILS.
   *
   * The amount comes from a frozen payment quote, never computed here. A
   * provider adapter that did its own conversion would be a second place the
   * exchange rate lives, and the two would eventually disagree.
   *
   * An ambiguous outcome is rethrown rather than reported as a failure. "The
   * charge failed" and "we do not know whether the charge happened" call for
   * opposite responses - retry versus reconcile - and collapsing them into one
   * result is how a customer gets billed twice.
   */
  async charge(input: ChargeInput): Promise<ChargeResult> {
    // The live-mode guard comes first, before any argument validation. A
    // misconfigured stack must be told it may not charge at all, rather than
    // being told its amount was malformed and left to "fix" that.
    assertLiveAllowed("charge");
    assertChargeSafety(input);

    if (isMock() && !isSimulator()) {
      return {
        success: true,
        providerChargeRef: `chg_${input.idempotencyKey}`,
        ...(input.issueInvoice
          ? { providerInvoiceRef: `inv_${input.idempotencyKey}`, providerPdfUrl: `https://icount.mock/doc/${input.idempotencyKey}.pdf` }
          : {}),
      };
    }

    try {
      const res = isSimulator() ? sim.simulateBill(billPayload(input)) : await api.bill(billPayload(input));
      return toChargeResult(res);
    } catch (err: any) {
      // An unknown outcome is rethrown. It is not a decline, and the caller
      // must be forced to handle it differently - a decline may be retried, an
      // unknown may not.
      if (err instanceof IcountOutcomeUnknown) throw err;
      // A decline IS a result: the provider answered, and the answer was no.
      // Letting it propagate as an exception would make every caller wrap this
      // in a try/catch to discover something the return type already models.
      return { success: false, failureCode: err?.message ?? "charge_failed" };
    }
  },

  /**
   * Refund. VERIFIED: POST doc/cancel with refund_cc: true.
   *
   * Two consequences of it being DOCUMENT-linked rather than charge-linked:
   *
   *   1. It needs the document reference. A charge recorded without a document
   *      cannot be refunded through this route.
   *   2. It is a FULL cancellation. A partial refund would return more than
   *      asked, so a partial request fails instead of being approximated.
   */
  async refund(input: RefundInput): Promise<ChargeResult> {
    // Same ordering rule as charge: whether we may talk to the provider at all
    // is settled before whether the request is well-formed.
    assertLiveAllowed("refund");

    if (input.expectedFullAmount != null && input.amount !== input.expectedFullAmount) {
      return { success: false, failureCode: "partial_refund_unsupported: doc/cancel cancels the whole document" };
    }
    if (!input.providerInvoiceRef) {
      return {
        success: false,
        failureCode: "missing_document_reference: doc/cancel is document-linked, a charge ref is not enough",
      };
    }

    const payload = {
      docType: input.providerInvoiceDocType || "invrec",
      docNum: input.providerInvoiceRef,
      refundCc: true,
      reason: input.reason,
    };

    try {
      if (isSimulator()) {
        const res = sim.simulateCancel({ docNum: payload.docNum });
        return { success: true, providerChargeRef: res.ref ?? input.providerChargeRef };
      }
      if (isMock()) return { success: true, providerChargeRef: `rfnd_${input.idempotencyKey}` };

      const res = await api.cancelDocument(payload);
      return { success: true, providerChargeRef: res.ref ?? input.providerChargeRef };
    } catch (err: any) {
      if (err instanceof IcountOutcomeUnknown) throw err;
      return { success: false, failureCode: err?.message || "refund_failed" };
    }
  },

  /**
   * Resolve an ambiguous charge. VERIFIED: POST cc/transactions.
   *
   * The safety net for the missing idempotency contract: when an outcome is
   * unknown, ask the provider what happened instead of retrying blind.
   */
  async lookupTransactions(query: { token?: string; clientId?: string; customClientId?: string }): Promise<unknown> {
    if (isSimulator()) return sim.simulateTransactions(query);
    if (isMock()) return { transactions: [] };
    assertLiveAllowed("transaction lookup");
    return api.transactions(query);
  },

  verifyWebhook(input: WebhookVerifyInput): boolean {
    const secret = process.env.ICOUNT_WEBHOOK_SECRET;
    if (!secret) return icountMode() !== "live"; // dev: accept without a secret; live: never
    const sig = (input.headers["x-icount-signature"] as string) || "";
    const expected = createHmac("sha256", secret).update(input.rawBody).digest("hex");
    try {
      return sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    } catch {
      return false;
    }
  },
};

/** The exact cc/bill payload, built once so mock, simulator and live agree. */
function billPayload(input: ChargeInput): api.BillInput {
  return {
    sum: input.chargeAmount!,
    token: input.token,
    currencyId: input.providerCurrencyId!,
    ...(input.providerCustomerId ? { clientId: input.providerCustomerId } : {}),
    ...(input.customClientId ? { customClientId: input.customClientId } : {}),
  };
}

/**
 * Translate a provider response into a charge result.
 *
 * A success with no reference is reported as needing reconciliation, not as a
 * clean success: without a reference the charge cannot later be reconciled or
 * refunded, and recording an invented id would make it look like it could.
 */
function toChargeResult(res: api.BillResult): ChargeResult {
  if (!res.chargeRef) {
    return {
      success: false,
      requiresReconciliation: true,
      failureCode: "charge_reference_missing: the provider accepted the charge but returned no usable reference",
    };
  }
  return {
    success: true,
    providerChargeRef: res.chargeRef,
    providerInvoiceRef: res.documentRef ?? undefined,
    providerPdfUrl: res.documentUrl ?? undefined,
  };
}
