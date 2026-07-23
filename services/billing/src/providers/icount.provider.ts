/**
 * iCount provider - Israeli PCI-compliant vault, payments + legal invoicing.
 *
 * Flow:
 *   1. Frontend opens iCount PayPage; customer enters card; iCount tokenizes
 *      and runs the J5 (1₪) preauthorization, releasing it immediately.
 *   2. The page returns a token reference; we confirm it here server-side.
 *   3. All future charges use the stored token via the iCount API.
 *   4. iCount issues the legal tax document (חשבונית מס) - the authoritative
 *      record; we keep only a reference.
 *
 * Config (env):
 *   ICOUNT_API_BASE   default https://api.icount.co.il/api/v3.php
 *   ICOUNT_CID / ICOUNT_USER / ICOUNT_PASS   company credentials
 *   ICOUNT_MODE       "live" | "mock"  (mock = deterministic, no network - dev/E2E)
 *   ICOUNT_WEBHOOK_SECRET   shared secret for webhook signature verification
 *
 * NOTE: exact iCount request/response shapes are encapsulated here. When wiring
 * to the real account, only the private request helpers below need adjustment;
 * the PaymentProvider surface stays stable.
 */
import axios from "axios";
import { createHmac, timingSafeEqual } from "crypto";
import type {
  PaymentProvider,
  TokenizeResult,
  ChargeInput,
  ChargeResult,
  RefundInput,
  WebhookVerifyInput,
} from "./provider";

const API_BASE = process.env.ICOUNT_API_BASE || "https://api.icount.co.il/api/v3.php";
// Mode is resolved at CALL time (not module load) so the env guard is
// testable and honors runtime configuration changes.
function isMock(): boolean {
  return (process.env.ICOUNT_MODE || "mock").toLowerCase() !== "live";
}

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

function creds() {
  return {
    cid: process.env.ICOUNT_CID || "",
    user: process.env.ICOUNT_USER || "",
    pass: process.env.ICOUNT_PASS || "",
  };
}

async function call(path: string, body: Record<string, unknown>): Promise<any> {
  const { cid, user, pass } = creds();
  if (!cid || !user || !pass) throw new Error("[icount] missing ICOUNT_CID/USER/PASS");
  const res = await axios.post(`${API_BASE}/${path}`, { cid, user, pass, ...body }, { timeout: 20_000 });
  if (res.data && res.data.status === false) {
    throw new Error(`[icount] ${path} failed: ${res.data.reason || JSON.stringify(res.data)}`);
  }
  return res.data;
}

export const icountProvider: PaymentProvider = {
  name: "ICOUNT",

  async tokenizeAndVerify(input): Promise<TokenizeResult> {
    if (isMock()) {
      // Deterministic mock - no network. Mirrors a successful tokenize + J5.
      return { token: `icmock_${input.pageToken}`, brand: "visa", last4: "4242", expMonth: 12, expYear: 2030 };
    }
    assertLiveAllowed("tokenize");
    // Confirm the PayPage token; iCount returns stored-card metadata.
    const data = await call("paypage/get_token_info", { page_token: input.pageToken });
    return {
      token: data.cc_token || data.token,
      brand: data.cc_type,
      last4: data.cc_last4 || data.last4,
      expMonth: data.cc_exp_month,
      expYear: data.cc_exp_year,
      providerCustomerId: data.client_id ? String(data.client_id) : undefined,
    };
  },

  async charge(input: ChargeInput): Promise<ChargeResult> {
    if (!isMock()) assertLiveAllowed("charge");
    if (isMock()) {
      return {
        success: true,
        providerChargeRef: `chg_${input.idempotencyKey}`,
        ...(input.issueInvoice ? { providerInvoiceRef: `inv_${input.idempotencyKey}`, providerPdfUrl: `https://icount.mock/doc/${input.idempotencyKey}.pdf` } : {}),
      };
    }
    try {
      // Charge the stored token and (optionally) issue the tax document in one call.
      const data = await call("cc/charge", {
        cc_token: input.token,
        sum: input.amount,
        currency_code: input.currency,
        description: input.description,
        idempotency_key: input.idempotencyKey,
        ...(input.issueInvoice ? { create_doc: "invrec", client_name: input.customer?.name, email: input.customer?.email, vat_id: input.customer?.vatId } : {}),
      });
      return {
        success: true,
        providerChargeRef: data.confirmation_code || data.deal_id || data.txn_id,
        providerInvoiceRef: data.docnum ? String(data.docnum) : undefined,
        providerPdfUrl: data.doc_url,
      };
    } catch (err: any) {
      return { success: false, failureCode: err?.response?.data?.error_code || err?.message || "charge_failed" };
    }
  },

  async refund(input: RefundInput): Promise<ChargeResult> {
    if (!isMock()) assertLiveAllowed("refund");
    if (isMock()) return { success: true, providerChargeRef: `rfnd_${input.idempotencyKey}` };
    try {
      const data = await call("cc/refund", {
        confirmation_code: input.providerChargeRef,
        sum: input.amount,
        currency_code: input.currency,
        reason: input.reason,
        idempotency_key: input.idempotencyKey,
      });
      return { success: true, providerChargeRef: data.confirmation_code || input.providerChargeRef };
    } catch (err: any) {
      return { success: false, failureCode: err?.message || "refund_failed" };
    }
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
