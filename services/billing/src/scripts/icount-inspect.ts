/**
 * iCount read-only account discovery.
 *
 * Establishes the real contract of an iCount account and its tokenization
 * PayPage WITHOUT touching money or mutating anything. Run explicitly:
 *
 *     npm run icount:inspect        (inside services/billing)
 *
 * It is a standalone entrypoint and is never imported by the service, so it
 * cannot run during startup.
 *
 * Safety properties, in order of importance:
 *
 *   1. ALLOWLIST. Only the three read-only actions below may be called. The
 *      allowlist is checked per request, so a typo or a future edit cannot
 *      reach a charge, refund, token-creation or document endpoint. There is no
 *      escape hatch and no override flag.
 *   2. No retries. A failed call is reported, not repeated - retry loops
 *      against a payments API are how you turn a bug into rate-limiting.
 *   3. Bounded. Every request has a timeout and the whole run has a deadline.
 *   4. Redacted. The token and any Authorization header are stripped from all
 *      output, including error paths.
 *   5. Values are not dumped. For discovery, the SHAPE is what matters, so
 *      unknown fields are reported by key name. Only an explicit safe subset is
 *      printed by value, and unrelated payment pages are reduced to a count.
 *
 * It never sets ICOUNT_ALLOW_LIVE and never consults ICOUNT_MODE: discovery is
 * read-only by construction, so mock mode has nothing to protect here.
 */
import axios from "axios";
import {
  authHeaders,
  icountApiBaseUrl,
  icountPaymentPageId,
  redactIcount,
  sanitizeIcountError,
} from "../providers/icount-config";

/**
 * The ONLY actions this tool may call. Read-only by definition: they return
 * account and page configuration and change nothing.
 *
 * Deliberately excluded, and not to be added here: anything under cc/*,
 * doc/*, token/*, client/*, and every paypage mutation (create/update/delete).
 */
const READ_ONLY_ACTIONS = ["auth/info", "paypage/info", "paypage/get_list"] as const;
type ReadOnlyAction = (typeof READ_ONLY_ACTIONS)[number];

const REQUEST_TIMEOUT_MS = 15_000;
const RUN_DEADLINE_MS = 60_000;

/**
 * Keys printed by value: page/account CONFIGURATION only.
 *
 * Deliberately excluded: the page id itself, page_url (which embeds it), and
 * every identifying field (email, phone, vat_id, addresses, user_id,
 * created_by/updated_by, social handles, logo).
 */
const SAFE_PAGE_KEYS = [
  // identity / state
  "page_name", "page_name_en", "is_active", "deleted", "is_deleted", "language",
  // what KIND of page this is - the decisive question
  "cc_page_version", "donation_page", "simplify_page", "is_shopify", "is_wooco",
  "doctype", "activate_autoinvoices", "post_action_success",
  // standing order (הוראת קבע). hk_page is the flag that would make iCount,
  // not GOTCHA, the renewal owner.
  "hk_page", "hk_payments", "hk_billing_day", "hk_issue_every",
  "hk_start_after", "hk_start_date", "hk_payment_sum_calc",
  "hk_payment_sum_calc_type",
  // amount: fixed in the page, or supplied per transaction?
  "custom_sum", "variable_price", "minimum_price", "max_payments", "max_sales",
  "currency_id", "add_vat", "auto_vat_detection", "tax_exempt",
  // callbacks
  "ipn_url", "success_url", "failure_url", "cancel_url", "callback_url",
  // which customer fields the page asks for
  "require_email", "require_fname_lname", "require_id", "require_phone",
  "require_tos", "request_address", "request_dob", "cc_holder_id_enabled",
  "custom_fields", "items",
  // 3DS / SCA
  "require_3ds", "allow_non_3ds_issuer", "require_3ds_txn_limit",
  "require_3ds_accum_period", "require_3ds_txn_period",
  // misc config
  "captcha", "income_type_id", "client_type_id", "installments_interest_rate",
] as const;

const SAFE_ACCOUNT_KEYS = [
  "businessType", "is_vat_exempt", "is_trial", "system_type",
  // the capability flags that decide whether tokenization is even possible
  "cc_enabled", "cc_storage_enabled", "cc_require_cvv", "cc_refund_enabled",
  "cc_provider", "hk_enabled", "always_allow_paynow",
  "autoinvoice_cc_enabled", "base_currency_code", "multi_currency",
  "create_doc_v2",
] as const;

const started = Date.now();

function deadlineExceeded(): boolean {
  return Date.now() - started > RUN_DEADLINE_MS;
}

/**
 * One allowlisted, unauthenticated-impossible, non-retrying request.
 *
 * `authHeaders()` throws when no token is configured, so this cannot silently
 * issue an anonymous request.
 */
async function readOnly(action: ReadOnlyAction, body: Record<string, unknown> = {}): Promise<any> {
  if (!READ_ONLY_ACTIONS.includes(action)) {
    // Unreachable via types; present because this is the safety boundary and a
    // future edit must fail loudly rather than quietly widen it.
    throw new Error(`[icount:inspect] refusing non-allowlisted action "${action}"`);
  }
  if (deadlineExceeded()) throw new Error("[icount:inspect] run deadline exceeded");

  try {
    const res = await axios.post(`${icountApiBaseUrl()}/${action}`, body, {
      timeout: REQUEST_TIMEOUT_MS,
      headers: authHeaders(),
      // A redirect from a payments API is not something to follow blindly.
      maxRedirects: 0,
      validateStatus: () => true,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`HTTP ${res.status}`);
    }
    if (res.data && res.data.status === false) {
      throw new Error(res.data.error_description || res.data.reason || "unknown_error");
    }
    return res.data;
  } catch (err) {
    throw sanitizeIcountError(action, err);
  }
}

/** Print a curated subset by value; report everything else by key name only. */
function maskPageId(text: string): string {
  const id = icountPaymentPageId();
  // Only substitute a distinctive id. A short one (e.g. "5") occurs inside
  // unrelated values like cc_page_version, and blind replacement would corrupt
  // the report it is meant to protect. The page id is excluded from the printed
  // key set outright, so this is belt-and-braces, not the primary control.
  if (!id || id.length < 4) return text;
  return text.split(id).join("<page-id>");
}

function describe(label: string, obj: unknown, safeKeys: readonly string[]): void {
  if (!obj || typeof obj !== "object") {
    console.log(`  ${label}: (no object returned)`);
    return;
  }
  const record = obj as Record<string, unknown>;
  const keys = Object.keys(record);

  console.log(`  ${label}:`);
  const shown = keys.filter((k) => safeKeys.includes(k));
  for (const k of shown) {
    const v = record[k];
    const printable = v === null || typeof v !== "object" ? String(v) : `<${Array.isArray(v) ? "array" : "object"}>`;
    console.log(`    ${k} = ${maskPageId(String(redactIcount(printable)))}`);
  }
  const rest = keys.filter((k) => !shown.includes(k));
  if (rest.length) {
    // Names only: enough to learn the contract, without dumping values.
    console.log(`    (other keys present, values not printed): ${rest.join(", ")}`);
  }
}

async function main(): Promise<void> {
  console.log("iCount read-only discovery");
  console.log("==========================");
  console.log(`base url : ${icountApiBaseUrl()}`);
  console.log(`allowlist: ${READ_ONLY_ACTIONS.join(", ")}`);
  console.log("no charge, refund, tokenization, or mutation is possible from this tool.\n");

  const pageId = icountPaymentPageId();
  if (!pageId) {
    console.error("ICOUNT_PAYMENT_PAGE_ID is not set - cannot inspect the PayPage.");
  }

  let authOk = false;

  // ── 1. auth/info: does a UI-generated token authenticate as Bearer? ──
  try {
    const info = await readOnly("auth/info", { get_company_info: true, get_settings: true });
    authOk = true;
    console.log("1. auth/info: AUTHENTICATED (Authorization: Bearer <token> accepted)\n");
    describe("account", info?.company_info ?? info, SAFE_ACCOUNT_KEYS);
    describe("settings", info?.company_settings ?? {}, SAFE_ACCOUNT_KEYS);
  } catch (err: any) {
    console.error(`1. auth/info: FAILED - ${err.message}`);
    console.error("   Bearer transport unconfirmed for a UI-generated token. Stopping.\n");
    process.exitCode = 1;
    return;
  }

  // ── 2. paypage/info: what IS the configured page? ──
  if (pageId) {
    try {
      const info = await readOnly("paypage/info", { paypage_id: Number(pageId) || pageId });
      console.log("\n2. paypage/info: OK\n");
      describe("paypage", info?.paypage_info ?? info, SAFE_PAGE_KEYS);
    } catch (err: any) {
      console.error(`\n2. paypage/info: FAILED - ${err.message}`);
    }
  }

  // ── 3. paypage/get_list: does the configured page exist here, and is it active? ──
  try {
    const list = await readOnly("paypage/get_list", {});
    const pages: any[] = Array.isArray(list?.paypages)
      ? list.paypages
      : Array.isArray(list)
        ? list
        : Object.values(list?.paypages ?? {});
    console.log(`\n3. paypage/get_list: OK (${pages.length} page(s) in account)\n`);

    const match = pages.find((p) => String(p?.paypage_id ?? p?.id ?? p?.page_id) === String(pageId));
    if (match) {
      console.log("  configured page FOUND in this account:");
      describe("entry", match, SAFE_PAGE_KEYS);
    } else if (pageId) {
      console.error(`  configured page NOT found in this account.`);
    }
    // Unrelated pages are deliberately not dumped.
  } catch (err: any) {
    console.error(`\n3. paypage/get_list: FAILED - ${err.message}`);
  }

  console.log("\n--------------------------------------------------");
  console.log(`authenticated : ${authOk ? "yes" : "no"}`);
  console.log("write ops run : none (allowlist is read-only)");
  console.log("money moved   : none");
}

main()
  .catch((err) => {
    // Even an unexpected failure must not leak the token.
    console.error("[icount:inspect] fatal:", String(redactIcount(err instanceof Error ? err.message : err)));
    process.exitCode = 1;
  })
  .finally(() => {
    // Importing the shared barrel opens a Redis/BullMQ client that retries
    // forever, so the event loop never drains on its own. A discovery CLI must
    // terminate; exit explicitly rather than hang after the report is printed.
    process.exit(process.exitCode ?? 0);
  });
