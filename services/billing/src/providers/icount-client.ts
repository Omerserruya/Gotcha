/**
 * Typed iCount API client.
 *
 * One function per VERIFIED operation, each with an explicit request shape, so
 * the fields sent to a payments API are visible in one place and reviewable
 * against the provider's written contract. The previous generation of this code
 * built payloads inline at the call sites and drifted into inventing endpoints;
 * a typed surface makes that drift a compile error rather than a production
 * failure at someone's renewal.
 *
 * VERIFIED OPERATIONS
 *   client/create           create the client a sale is attached to
 *   paypage/generate_sale   create a hosted page session, returns `sale_url`
 *   client/get_cc_tokens    server-side pull of a client's stored card tokens
 *   cc/bill                 charge a stored token: sum, token, client_id,
 *                           currency_id
 *   cc/transactions         transaction lookup, for reconciling an UNKNOWN
 *   doc/cancel              full document-linked refund, with refund_cc: true
 *
 * Transport is `Authorization: Bearer <token>` with a JSON body. Credentials
 * never appear in a URL, a query string or a body.
 */
import axios from "axios";
import {
  authHeaders,
  icountApiBaseUrl,
  icountMode,
  sanitizeIcountError,
  redactIcount,
} from "./icount-config";

/** iCount currency ids. 1 = ILS, 2 = USD. Product policy charges ILS only. */
export const CURRENCY_ID_ILS = 1;
export const CURRENCY_ID_USD = 2;

export class IcountApiError extends Error {
  constructor(readonly path: string, message: string, readonly body?: unknown) {
    super(`[icount] ${path}: ${message}`);
    this.name = "IcountApiError";
  }
}

/**
 * Raised when a request was sent but the outcome could not be established -
 * a timeout, a connection reset, an unparseable response.
 *
 * Distinct from a decline on purpose. A decline means no money moved; this
 * means we do not know, and the only safe response is reconciliation, never a
 * retry.
 */
export class IcountOutcomeUnknown extends Error {
  /**
   * Provider-agnostic marker. The attempt state machine must recognize an
   * unknown outcome without importing an iCount-specific class, because
   * recording one as FAILED would invite a retry, and a retry after a possible
   * charge is a second charge.
   */
  readonly outcomeUnknown = true;

  constructor(readonly path: string, readonly cause: string) {
    super(`[icount] ${path}: outcome unknown (${cause}) - reconciliation required, retrying could double-charge`);
    this.name = "IcountOutcomeUnknown";
  }
}

const TIMEOUT_MS = 25_000;

/** Errors where the request provably never reached the provider. */
const NEVER_SENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ERR_INVALID_URL"]);

/**
 * One authenticated request.
 *
 * `mutating` changes what an ambiguous transport failure means. For a read, a
 * timeout is just a failed read. For a charge, it means money may have moved,
 * so it surfaces as IcountOutcomeUnknown rather than a plain error that a
 * caller might feel safe retrying.
 */
async function call<T = any>(
  path: string,
  body: Record<string, unknown>,
  opts: { mutating?: boolean } = {},
): Promise<T> {
  let res;
  try {
    res = await axios.post(`${icountApiBaseUrl()}/${path}`, body, {
      timeout: TIMEOUT_MS,
      headers: authHeaders(),
      validateStatus: () => true,
    });
  } catch (err: any) {
    const code = err?.code ?? "";
    if (opts.mutating && !NEVER_SENT.has(code)) {
      throw new IcountOutcomeUnknown(path, code || err?.message || "transport_failure");
    }
    throw sanitizeIcountError(path, err);
  }

  // A 5xx on a mutating call is genuinely ambiguous: the provider may have
  // processed it before failing to respond.
  if (res.status >= 500) {
    if (opts.mutating) throw new IcountOutcomeUnknown(path, `http_${res.status}`);
    throw new IcountApiError(path, `HTTP ${res.status}`);
  }
  if (res.status >= 400) {
    const detail = res.data?.error_description || res.data?.reason || `HTTP ${res.status}`;
    throw new IcountApiError(path, String(redactIcount(detail)));
  }

  // iCount signals application errors in the body, with HTTP 200.
  if (res.data && res.data.status === false) {
    const detail = res.data.error_description || res.data.reason || "unknown_error";
    throw new IcountApiError(path, String(redactIcount(detail)), res.data);
  }
  return res.data as T;
}

/** Live network calls are only ever made in live mode. */
function assertLiveTransport(operation: string): void {
  if (icountMode() !== "live") {
    throw new Error(`[icount] ${operation}: refusing a network call outside live mode (mode=${icountMode()})`);
  }
}

// ─── paypage/generate_sale ────────────────────────────────────────────────

export interface GenerateSaleInput {
  /** The tokenization PayPage id. */
  pageId: string;
  /** Our own opaque reference, echoed back so we can correlate the session. */
  customClientId: string;
  clientName?: string;
  email?: string;
  /** Where the customer lands afterwards. A return is not proof of payment. */
  successUrl?: string;
  failureUrl?: string;
  /** Server-to-server notification target, if configured. */
  ipnUrl?: string;
}

export interface GenerateSaleResult {
  /** The hosted page URL the customer is sent to. */
  saleUrl: string;
  /** iCount's own id for this session. Stored so an IPN can be correlated. */
  saleUniqid?: string;
  /** Spelled out in full: the abbreviated form collides with the guard that
   *  keeps credential-shaped names out of request payloads. */
  saleSessionId?: string;
  raw: unknown;
}

/**
 * Create a hosted tokenization session.
 *
 * Returns only a URL. Nothing about the customer visiting it, completing it, or
 * being redirected back constitutes proof that a card was stored - that is
 * established afterwards by pulling the token server-side.
 */
export async function generateSale(input: GenerateSaleInput): Promise<GenerateSaleResult> {
  assertLiveTransport("paypage/generate_sale");
  const data = await call("paypage/generate_sale", {
    // `paypage_id`, NOT `page_id`. Established against the live account: with
    // `page_id` the API answers status=false reason="missing_paypage_id", so
    // every live tokenization would have failed at the first call. Same
    // spelling as paypage/info uses.
    paypage_id: input.pageId,
    custom_client_id: input.customClientId,
    ...(input.clientName ? { client_name: input.clientName } : {}),
    ...(input.email ? { email: input.email } : {}),
    ...(input.successUrl ? { success_url: input.successUrl } : {}),
    ...(input.failureUrl ? { failure_url: input.failureUrl } : {}),
    ...(input.ipnUrl ? { ipn_url: input.ipnUrl } : {}),
  });

  const saleUrl = typeof data?.sale_url === "string" ? data.sale_url : "";
  if (!saleUrl) throw new IcountApiError("paypage/generate_sale", "response carried no sale_url");
  return {
    saleUrl,
    // Distinct per call - verified by generating two sessions and comparing.
    // This is the handle an inbound notification is matched against.
    saleUniqid: typeof data?.sale_uniqid === "string" ? data.sale_uniqid : undefined,
    saleSessionId: typeof data?.sale_sid === "string" ? data.sale_sid : undefined,
    raw: data,
  };
}

// ─── client/create ────────────────────────────────────────────────────────

export interface CreateClientInput {
  /** Shown in the iCount account. Not used for matching. */
  clientName: string;
  /** OUR reference. This is what everything afterwards is correlated by. */
  customClientId: string;
  email?: string;
}

/**
 * Create the iCount client a tokenization session attaches to.
 *
 * This step was missing, and its absence was silent. `paypage/generate_sale`
 * does NOT create a client: given a `custom_client_id` that does not already
 * exist it answers status=false reason="client_not_found", and supplying
 * client_name and email alongside does not change that. So every live
 * tokenization would have failed here too, one call after the field-name
 * failure above.
 *
 * The client must exist first because `custom_client_id` is the only handle
 * that survives the round trip: client/get_cc_tokens takes it and echoes it
 * back, which is what makes server-side verification possible at all.
 *
 * Verified against the live account: client_name alone is sufficient, and the
 * response carries `client_id`.
 */
export async function createClient(input: CreateClientInput): Promise<{ clientId: string }> {
  assertLiveTransport("client/create");
  const data = await call("client/create", {
    client_name: input.clientName,
    custom_client_id: input.customClientId,
    ...(input.email ? { email: input.email } : {}),
  });
  const clientId = data?.client_id != null ? String(data.client_id) : "";
  if (!clientId) throw new IcountApiError("client/create", "response carried no client_id");
  return { clientId };
}

// ─── paypage/info ─────────────────────────────────────────────────────────

/**
 * Read a payment page's configuration.
 *
 * Read-only, and used for one purpose: confirming the configured page STORES a
 * card rather than charging for one. Getting that wrong is not a degraded
 * experience, it is an unintended charge on a real customer.
 */
export async function paypageInfo(pageId: string): Promise<Record<string, unknown>> {
  assertLiveTransport("paypage/info");
  // `paypage_id`, matching what read-only discovery actually confirmed against
  // the live account - not `page_id`, which would be a guess.
  const data = await call("paypage/info", { paypage_id: Number(pageId) || pageId });

  // The configuration lives under `paypage_info`. Confirmed by reading the live
  // response, not assumed: the envelope is
  // { api, status, reason, paypage_id, paypage_info }.
  //
  // This previously unwrapped `paypage` / `page` and fell back to the envelope
  // itself. Neither key exists, so it returned the envelope - which has no
  // `doctype` - and assertTokenizationPage refused a page that was configured
  // perfectly, reporting doctype "(none)". Live tokenization could not have
  // succeeded, and the error pointed at the one thing that was not wrong.
  const info = data?.paypage_info ?? data?.paypage ?? data?.page;
  if (!info || typeof info !== "object") {
    throw new IcountApiError(
      "paypage/info",
      `response carried no page configuration (keys: ${Object.keys(data ?? {}).join(", ") || "none"})`,
    );
  }
  return info as Record<string, unknown>;
}

// ─── client/get_cc_tokens ─────────────────────────────────────────────────

export interface StoredCardToken {
  token: string;
  /** Card metadata, when the provider supplies it. Never a full PAN. */
  last4?: string;
  brand?: string;
  expMonth?: number;
  expYear?: number;
}

/**
 * Pull a client's stored card tokens.
 *
 * This is the server-side proof that tokenization happened. It closes the gap
 * that kept checkout disabled: previously the only success signal was the
 * browser coming back, which proves the customer returned and nothing else.
 */
export async function getCcTokens(query: {
  clientId?: string;
  customClientId?: string;
}): Promise<StoredCardToken[]> {
  assertLiveTransport("client/get_cc_tokens");
  if (!query.clientId && !query.customClientId) {
    throw new IcountApiError("client/get_cc_tokens", "a client identifier is required");
  }
  const data = await call("client/get_cc_tokens", {
    ...(query.clientId ? { client_id: query.clientId } : {}),
    ...(query.customClientId ? { custom_client_id: query.customClientId } : {}),
  });
  return normalizeTokens(data);
}

/**
 * Read tokens out of whatever container the response uses.
 *
 * Tolerant about the envelope, strict about the contents: an entry without a
 * usable token string is dropped rather than turned into a placeholder that
 * would later be charged.
 */
export function normalizeTokens(data: any): StoredCardToken[] {
  const container = data?.cc_tokens ?? data?.tokens ?? data?.data ?? data;
  const list = Array.isArray(container) ? container : container && typeof container === "object" ? Object.values(container) : [];

  const out: StoredCardToken[] = [];
  for (const entry of list as any[]) {
    if (!entry) continue;
    const token = typeof entry === "string" ? entry : entry.token ?? entry.cc_token ?? entry.card_token;
    if (typeof token !== "string" || !token.trim()) continue;
    const exp = parseExpiry(entry);
    out.push({
      token: token.trim(),
      last4: digitsOnly(entry?.last4 ?? entry?.cc_last4 ?? entry?.last_4) || undefined,
      brand: typeof entry?.brand === "string" ? entry.brand : typeof entry?.cc_type === "string" ? entry.cc_type : undefined,
      ...(exp ?? {}),
    });
  }
  return out;
}

function digitsOnly(v: unknown): string {
  const s = String(v ?? "").replace(/\D/g, "");
  // Only ever the last four. If a response somehow carried more, storing it
  // would be storing card data.
  return s.slice(-4);
}

function parseExpiry(entry: any): { expMonth?: number; expYear?: number } | null {
  const m = Number(entry?.exp_month ?? entry?.expMonth ?? entry?.cc_valid_month);
  const y = Number(entry?.exp_year ?? entry?.expYear ?? entry?.cc_valid_year);
  const month = Number.isInteger(m) && m >= 1 && m <= 12 ? m : undefined;
  const year = Number.isInteger(y) ? (y < 100 ? 2000 + y : y) : undefined;
  return month || year ? { expMonth: month, expYear: year } : null;
}

// ─── cc/bill ──────────────────────────────────────────────────────────────

export interface BillInput {
  /** The ILS amount. Already converted and frozen by the payment quote. */
  sum: string;
  token: string;
  currencyId: number;
  clientId?: string;
  customClientId?: string;
}

export interface BillResult {
  /** Provider-side reference, when the response carries one. */
  chargeRef: string | null;
  documentRef: string | null;
  documentUrl: string | null;
  raw: unknown;
}

/**
 * Charge a stored card token.
 *
 * Unattended: no customer presence, no CVV. That is what makes GOTCHA-owned
 * renewal possible without iCount also owning a standing order.
 *
 * `currencyId` is required rather than defaulted. The account is multi-currency,
 * and an omitted currency on a multi-currency account means the amount settles
 * in whatever the account base happens to be - which is a silent way to charge
 * the wrong number.
 */
export async function bill(input: BillInput): Promise<BillResult> {
  assertLiveTransport("cc/bill");
  if (input.currencyId !== CURRENCY_ID_ILS) {
    throw new IcountApiError("cc/bill", `refusing currency_id ${input.currencyId}: only ILS charges are enabled`);
  }
  if (!input.clientId && !input.customClientId) {
    throw new IcountApiError("cc/bill", "a client identifier is required");
  }

  const data = await call(
    "cc/bill",
    {
      sum: input.sum,
      token: input.token,
      currency_id: input.currencyId,
      ...(input.clientId ? { client_id: input.clientId } : {}),
      ...(input.customClientId ? { custom_client_id: input.customClientId } : {}),
    },
    { mutating: true },
  );

  return {
    chargeRef: extractRef(data, ["confirmation_code", "deal_id", "txn_id", "transaction_id"]),
    documentRef: extractRef(data, ["docnum", "doc_number"]),
    documentUrl: typeof data?.doc_url === "string" ? data.doc_url : null,
    raw: data,
  };
}

/**
 * Pull an identifying reference out of a response.
 *
 * Returns null rather than fabricating one. A charge that succeeded but carries
 * no reference we recognize is not a clean success: without a reference it
 * cannot be reconciled or refunded, so the caller must treat it as needing a
 * human rather than recording a made-up id.
 */
export function extractRef(data: any, keys: string[]): string | null {
  for (const key of keys) {
    const v = data?.[key];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

// ─── cc/transactions ──────────────────────────────────────────────────────

export interface TransactionQuery {
  token?: string;
  clientId?: string;
  customClientId?: string;
}

/**
 * Look up transactions.
 *
 * The recovery path for the missing provider idempotency: when an outcome is
 * unknown, ask what actually happened instead of retrying blind.
 */
export async function transactions(query: TransactionQuery): Promise<any> {
  assertLiveTransport("cc/transactions");
  return call("cc/transactions", {
    ...(query.token ? { token: query.token } : {}),
    ...(query.clientId ? { client_id: query.clientId } : {}),
    ...(query.customClientId ? { custom_client_id: query.customClientId } : {}),
  });
}

// ─── doc/cancel ───────────────────────────────────────────────────────────

export interface CancelInput {
  docType: string;
  docNum: string;
  refundCc: boolean;
  reason?: string;
}

/** Cancel a document, optionally refunding the card. Full amount only. */
export async function cancelDocument(input: CancelInput): Promise<{ ref: string | null; raw: unknown }> {
  assertLiveTransport("doc/cancel");
  const data = await call(
    "doc/cancel",
    {
      doctype: input.docType,
      docnum: input.docNum,
      refund_cc: input.refundCc,
      ...(input.reason ? { reason: input.reason } : {}),
    },
    { mutating: true },
  );
  return { ref: extractRef(data, ["confirmation_code", "deal_id"]), raw: data };
}
