/**
 * The one client for Meta's official WhatsApp onboarding and management APIs.
 *
 * Scope: everything the multi-number architecture needs to INSPECT, ONBOARD,
 * SUBSCRIBE, DIAGNOSE and REPAIR a business phone number. Message sending
 * stays in `channels/whatsapp.adapter.ts`; that path is load-bearing and is
 * not touched by this project.
 *
 * Three rules this module exists to enforce:
 *
 *  1. **Official endpoints only.** Every method below cites the Meta doc it
 *     implements. Nothing is reverse-engineered, nothing scrapes a web UI, and
 *     there is no browser automation anywhere in this codebase's WhatsApp path.
 *  2. **One Graph version.** Via `metaGraphBaseUrl()`. The single exception is
 *     the OAuth code exchange, explained at `exchangeCode`.
 *  3. **Errors are structured, never swallowed.** Every failure becomes a
 *     `MetaApiError` carrying Meta's own code, message and body. Phase 10
 *     requires showing the customer the exact reason and the API response;
 *     that is only possible if nothing upstream flattened it to a boolean.
 *
 * Reference: docs/integrations/whatsapp/01-meta-api-inventory.md
 */

import axios, { type AxiosInstance, type Method } from "axios";
import { metaGraphBaseUrl } from "../lib/meta-graph-version";
import type {
  MetaDebugToken,
  MetaHealthStatus,
  MetaPhoneNumber,
  MetaSubscribedApp,
  MetaWaba,
} from "./meta-types";

/**
 * A Graph API failure with everything Meta told us preserved.
 *
 * `body` is kept whole because the health and repair UI shows Meta's own
 * wording. Paraphrasing "your account is restricted for policy violation X"
 * into "something went wrong" is how a customer ends up unable to act on a
 * problem only they can fix.
 */
export class MetaApiError extends Error {
  readonly httpStatus?: number;
  readonly code?: number;
  readonly subcode?: number;
  readonly type?: string;
  readonly fbtraceId?: string;
  readonly body?: unknown;
  /** Which of our operations failed, for the audit trail. */
  readonly operation: string;

  constructor(operation: string, err: unknown) {
    const response = (err as any)?.response;
    const metaErr = response?.data?.error;
    const message =
      metaErr?.error_user_msg ||
      metaErr?.message ||
      (err as any)?.message ||
      "Meta API request failed";
    super(`[${operation}] ${message}`);
    this.name = "MetaApiError";
    this.operation = operation;
    this.httpStatus = typeof response?.status === "number" ? response.status : undefined;
    this.code = typeof metaErr?.code === "number" ? metaErr.code : undefined;
    this.subcode = typeof metaErr?.error_subcode === "number" ? metaErr.error_subcode : undefined;
    this.type = metaErr?.type;
    this.fbtraceId = metaErr?.fbtrace_id;
    this.body = response?.data;
  }

  /** True when a bare retry could plausibly succeed. Deliberately narrow. */
  get isRetryable(): boolean {
    if (this.httpStatus === 429 || (this.httpStatus ?? 0) >= 500) return true;
    // 1 unknown/transient, 2 temporary outage, 4 app rate limit.
    return this.code === 1 || this.code === 2 || this.code === 4;
  }

  /**
   * A permission problem rather than a state problem. Codes 10 and 200-299 are
   * Graph's permission family; 190 is an invalid or revoked token.
   */
  get isPermissionError(): boolean {
    if (this.httpStatus === 403) return true;
    const c = this.code ?? -1;
    return c === 10 || c === 190 || (c >= 200 && c <= 299);
  }

  /** Body with anything token-shaped removed. Safe to persist and display. */
  redactedBody(): unknown {
    return redact(this.body);
  }
}

/** Strip token-ish values before anything is written to the audit trail. */
function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value == null) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (/token|secret|pin|password|credential/i.test(k)) {
      out[k] = "[redacted]";
    } else {
      out[k] = redact(v, depth + 1);
    }
  }
  return out;
}

export interface MetaClientOptions {
  /** Business token for the customer, or an app token for `debug_token`. */
  accessToken: string;
  /** Overridable for tests. Defaults to the canonical versioned Graph base. */
  baseUrl?: string;
  timeoutMs?: number;
  http?: AxiosInstance;
}

/**
 * Result of an operation whose failure is EXPECTED and meaningful.
 *
 * Used where "it did not work" is a diagnosis rather than an exception: a
 * webhook subscription we may not be permitted to make, a health call on a
 * WABA we can see but not read. The inspector needs to record all of these
 * and keep going, so throwing would be wrong.
 */
export type Attempted<T> =
  | { ok: true; value: T }
  | { ok: false; error: MetaApiError };

/**
 * One structured line per Graph request.
 *
 * Added after the Coexistence history sync silently never happened. The
 * onboarding pipeline recorded a tidy list of SUCCESS steps and the customer
 * saw a connected number, while the one call that actually starts the history
 * transfer was never made by anybody - and there was no way to see that from
 * the outside, because we only ever logged the steps we DID run.
 *
 * The token is never logged: it is in a header this function is not given, and
 * the response is capped rather than dumped, because a Graph response can carry
 * a customer's phone numbers and display names.
 */
function logGraphCall(entry: {
  operation: string;
  method: string;
  path: string;
  status?: number;
  durationMs: number;
  request?: unknown;
  response?: unknown;
  failed?: boolean;
}): void {
  const body = (v: unknown) => {
    if (v === undefined) return "-";
    try {
      return JSON.stringify(v).slice(0, 400);
    } catch {
      return "[unserializable]";
    }
  };
  const line =
    `[meta-graph] op=${entry.operation} ${entry.method.toUpperCase()} ${entry.path} ` +
    `status=${entry.status ?? "net"} ms=${entry.durationMs} ` +
    `req=${body(entry.request)} res=${body(entry.response)}`;
  if (entry.failed) console.error(line);
  else console.log(line);
}

export class MetaWhatsAppClient {
  private readonly http: AxiosInstance;
  private readonly token: string;
  private readonly baseUrl: string;

  constructor(opts: MetaClientOptions) {
    this.token = opts.accessToken;
    this.baseUrl = (opts.baseUrl || metaGraphBaseUrl()).replace(/\/+$/, "");
    this.http =
      opts.http ||
      axios.create({
        timeout: opts.timeoutMs ?? 20_000,
        // Graph returns meaningful bodies on 4xx; we want them, not a throw
        // without context. 5xx still throws through the axios default.
        validateStatus: (s) => s >= 200 && s < 300,
      });
  }

  // ── transport ──────────────────────────────────────────────

  private async call<T>(
    operation: string,
    method: Method,
    path: string,
    opts: { params?: Record<string, unknown>; data?: unknown; token?: string } = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const startedAt = Date.now();
    try {
      const res = await this.http.request<T>({
        method,
        url,
        params: opts.params,
        data: opts.data,
        headers: { Authorization: `Bearer ${opts.token ?? this.token}` },
      });
      logGraphCall({
        operation,
        method,
        path,
        status: res.status,
        durationMs: Date.now() - startedAt,
        request: opts.data,
        response: res.data,
      });
      return res.data;
    } catch (err) {
      const anyErr = err as { response?: { status?: number; data?: unknown } };
      logGraphCall({
        operation,
        method,
        path,
        status: anyErr?.response?.status,
        durationMs: Date.now() - startedAt,
        request: opts.data,
        response: anyErr?.response?.data,
        failed: true,
      });
      throw new MetaApiError(operation, err);
    }
  }

  /** `call`, but an error is returned rather than thrown. See `Attempted`. */
  private async attempt<T>(fn: () => Promise<T>): Promise<Attempted<T>> {
    try {
      return { ok: true, value: await fn() };
    } catch (err) {
      if (err instanceof MetaApiError) return { ok: false, error: err };
      return { ok: false, error: new MetaApiError("unknown", err) };
    }
  }

  // ── 1. Token exchange and introspection ────────────────────

  /**
   * Exchange an Embedded Signup authorization code for a customer-scoped
   * business token.
   *
   *   GET /oauth/access_token?client_id&client_secret&code
   *
   * Meta documents no `redirect_uri` for the popup code, and this is an OAuth
   * call rather than a WhatsApp call, so any live Graph version serves it.
   *
   * `graphVersionOverride` exists for one real reason: the Facebook JS SDK
   * mints the code against ITS OWN version, and if the SDK is ever moved to a
   * version whose OAuth behaviour differs, the exchange must be able to follow
   * it without moving every WhatsApp call. It is not a fallback chain, and it
   * must never become one: four speculative attempts, which is what this
   * replaces, cannot distinguish "wrong call" from "wrong credentials".
   */
  static async exchangeCode(params: {
    appId: string;
    appSecret: string;
    code: string;
    graphVersionOverride?: string;
    http?: AxiosInstance;
    timeoutMs?: number;
  }): Promise<string> {
    const base = params.graphVersionOverride
      ? `https://graph.facebook.com/${params.graphVersionOverride}`
      : metaGraphBaseUrl();
    const http = params.http || axios.create({ timeout: params.timeoutMs ?? 20_000 });
    try {
      const res = await http.get(`${base}/oauth/access_token`, {
        params: {
          client_id: params.appId,
          client_secret: params.appSecret,
          code: params.code,
        },
      });
      const data = res.data;
      const token = typeof data === "string" ? data : data?.access_token;
      if (typeof token !== "string" || token.length < 10) {
        // A 200 with no usable token is a contract violation, not a retry
        // case. Failing here beats writing an unusable channel row.
        throw new Error("Meta returned no access_token for the authorization code");
      }
      return token;
    } catch (err) {
      if (err instanceof MetaApiError) throw err;
      throw new MetaApiError("exchangeCode", err);
    }
  }

  /**
   * Read what a token was actually granted.
   *
   *   GET /debug_token?input_token=<TOKEN>   with an APP access token
   *
   * Authenticated with `<APP_ID>|<APP_SECRET>` rather than the business token:
   * a token cannot introspect itself.
   *
   * https://developers.facebook.com/docs/whatsapp/embedded-signup/manage-accounts/
   */
  async debugToken(appId: string, appSecret: string): Promise<MetaDebugToken> {
    const res = await this.call<{ data: MetaDebugToken }>(
      "debugToken",
      "get",
      "/debug_token",
      { params: { input_token: this.token }, token: `${appId}|${appSecret}` },
    );
    return res.data;
  }

  /**
   * Asset IDs granted for one permission, in full.
   *
   * Meta's own guidance is to "capture the first ID in the `target_ids`
   * array". That is correct for a single-WABA integration and is the origin
   * of the single-number assumption this project removes, so we return all.
   */
  static grantedTargets(debug: MetaDebugToken, scope: string): string[] {
    const match = debug.granular_scopes?.find((s) => s.scope === scope);
    return match?.target_ids ? [...match.target_ids] : [];
  }

  static grantedScopes(debug: MetaDebugToken): string[] {
    const granular = (debug.granular_scopes || []).map((s) => s.scope);
    return Array.from(new Set([...(debug.scopes || []), ...granular]));
  }

  // ── 2. Business Portfolio ──────────────────────────────────

  /**
   * WABAs the portfolio owns.
   *   GET /<BUSINESS_PORTFOLIO_ID>/owned_whatsapp_business_accounts
   * Requires `business_management`.
   */
  async ownedWabas(portfolioId: string): Promise<Attempted<MetaWaba[]>> {
    return this.attempt(async () => {
      const res = await this.call<{ data: MetaWaba[] }>(
        "ownedWabas",
        "get",
        `/${portfolioId}/owned_whatsapp_business_accounts`,
        { params: { limit: 100 } },
      );
      return res.data || [];
    });
  }

  /**
   * WABAs shared with the portfolio but owned elsewhere.
   *   GET /<BUSINESS_PORTFOLIO_ID>/client_whatsapp_business_accounts
   * Requires `whatsapp_business_management` at ADVANCED access.
   */
  async clientWabas(portfolioId: string): Promise<Attempted<MetaWaba[]>> {
    return this.attempt(async () => {
      const res = await this.call<{ data: MetaWaba[] }>(
        "clientWabas",
        "get",
        `/${portfolioId}/client_whatsapp_business_accounts`,
        { params: { limit: 100 } },
      );
      return res.data || [];
    });
  }

  // ── 3. WABA ────────────────────────────────────────────────

  private static readonly WABA_FIELDS = [
    "id",
    "name",
    "currency",
    "timezone_id",
    "message_template_namespace",
    "account_review_status",
    "business_verification_status",
    "primary_funding_id",
    "owner_business_info",
    "on_behalf_of_business_info",
  ].join(",");

  /** GET /<WABA_ID> with every field the inspector reads. */
  async getWaba(wabaId: string): Promise<Attempted<MetaWaba>> {
    return this.attempt(() =>
      this.call<MetaWaba>("getWaba", "get", `/${wabaId}`, {
        params: { fields: MetaWhatsAppClient.WABA_FIELDS },
      }),
    );
  }

  private static readonly PHONE_FIELDS = [
    "id",
    "display_phone_number",
    "verified_name",
    "quality_rating",
    "code_verification_status",
    "name_status",
    "status",
    "platform_type",
    "is_on_biz_app",
    "is_official_business_account",
    "messaging_limit_tier",
    "throughput",
    "account_mode",
    "last_onboarded_time",
    "webhook_configuration",
  ].join(",");

  /**
   * Every business phone number on a WABA.
   *   GET /<WABA_ID>/phone_numbers
   *
   * Explicitly requests `platform_type` and `is_on_biz_app`, the two fields
   * that decide which onboarding flow a number needs. Meta omits them from
   * the default field set, which is why the previous implementation could not
   * tell a Coexistence number from a fresh one.
   */
  async listPhoneNumbers(wabaId: string): Promise<Attempted<MetaPhoneNumber[]>> {
    return this.attempt(async () => {
      const res = await this.call<{ data: MetaPhoneNumber[] }>(
        "listPhoneNumbers",
        "get",
        `/${wabaId}/phone_numbers`,
        { params: { fields: MetaWhatsAppClient.PHONE_FIELDS, limit: 100 } },
      );
      return res.data || [];
    });
  }

  /** GET /<PHONE_NUMBER_ID> with the same field set. */
  async getPhoneNumber(phoneNumberId: string): Promise<Attempted<MetaPhoneNumber>> {
    return this.attempt(() =>
      this.call<MetaPhoneNumber>("getPhoneNumber", "get", `/${phoneNumberId}`, {
        params: { fields: MetaWhatsAppClient.PHONE_FIELDS },
      }),
    );
  }

  // ── 4. Webhook subscriptions ───────────────────────────────

  /**
   * Apps currently subscribed to this WABA's webhooks.
   *   GET /<WABA_ID>/subscribed_apps
   *
   * Our app appearing here is the ONLY proof that inbound messages can reach
   * us. Everything else about a number can look healthy while it is silently
   * unreachable, which is the failure the previous implementation could not
   * detect because it never read this back after subscribing.
   */
  async listSubscribedApps(wabaId: string): Promise<Attempted<MetaSubscribedApp[]>> {
    return this.attempt(async () => {
      const res = await this.call<{ data: MetaSubscribedApp[] }>(
        "listSubscribedApps",
        "get",
        `/${wabaId}/subscribed_apps`,
        {},
      );
      return res.data || [];
    });
  }

  /**
   * Subscribe our app to this WABA's webhooks.
   *   POST /<WABA_ID>/subscribed_apps
   *
   * Idempotent at Meta: subscribing an already-subscribed app succeeds.
   *
   * We deliberately do NOT pass `override_callback_uri`. GOTCHA has one
   * webhook endpoint and routes by `phone_number_id` from the payload; giving
   * each WABA its own URL would multiply the things that must stay healthy
   * without improving isolation. Reasoning in the API inventory, section 7.
   *
   * https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/override/
   */
  async subscribeApp(wabaId: string): Promise<Attempted<{ success?: boolean }>> {
    return this.attempt(() =>
      this.call<{ success?: boolean }>(
        "subscribeApp",
        "post",
        `/${wabaId}/subscribed_apps`,
        { data: {} },
      ),
    );
  }

  /**
   * Unsubscribe our app from a WABA's webhooks.
   *   DELETE /<WABA_ID>/subscribed_apps
   *
   * Callers must confirm no OTHER connected number shares this WABA first.
   * Meta subscribes at WABA level, not number level, so unsubscribing to
   * disconnect one number would silence its siblings. That check lives in the
   * disconnect service, where the tenant's other numbers are visible.
   */
  /**
   * Ask Meta to start a Coexistence synchronization.
   *
   * THIS is what starts it. Subscribing to the `history` webhook only says
   * where to deliver; it does not ask for anything, and without this call
   * nothing is ever sent. That was the defect: the webhook field was
   * subscribed, the number connected cleanly, every pipeline step reported
   * SUCCESS, and no history ever arrived - with nothing anywhere to say why.
   *
   * Two sync types, per Meta's onboarding guide:
   *   `smb_app_state_sync` - the business's contacts
   *   `history`            - up to 180 days of past messages
   *
   * Both are ONCE ONLY. Repeating either requires the customer to offboard in
   * the WhatsApp Business app and complete Embedded Signup again, so a caller
   * must not retry this blindly. There is also a hard 24-hour deadline from
   * onboarding, after which Meta refuses.
   *
   * https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users/
   */
  async requestSmbSync(
    phoneNumberId: string,
    syncType: "history" | "smb_app_state_sync",
  ): Promise<Attempted<{ success?: boolean }>> {
    return this.attempt(() =>
      this.call<{ success?: boolean }>(
        `requestSmbSync:${syncType}`,
        "post",
        `/${phoneNumberId}/smb_app_data`,
        { data: { messaging_product: "whatsapp", sync_type: syncType } },
      ),
    );
  }

  async unsubscribeApp(wabaId: string): Promise<Attempted<{ success?: boolean }>> {
    return this.attempt(() =>
      this.call<{ success?: boolean }>(
        "unsubscribeApp",
        "delete",
        `/${wabaId}/subscribed_apps`,
        {},
      ),
    );
  }

  // ── 5. Health ──────────────────────────────────────────────

  /**
   * GET /<WABA_ID or PHONE_NUMBER_ID>?fields=health_status
   *
   * Returns Meta's own assessment, including `possible_solution` text that we
   * show verbatim. Works on both node types, hence one method.
   */
  async getHealthStatus(nodeId: string): Promise<Attempted<MetaHealthStatus>> {
    return this.attempt(async () => {
      const res = await this.call<{ health_status?: MetaHealthStatus }>(
        "getHealthStatus",
        "get",
        `/${nodeId}`,
        { params: { fields: "health_status" } },
      );
      return res.health_status || {};
    });
  }

  // ── 6. Verification and registration ───────────────────────

  /**
   * POST /<PHONE_NUMBER_ID>/request_code
   *
   * An already-verified number returns HTTP 400 with code 136024. That is a
   * SUCCESS for us, and callers should check `META_ERROR.ALREADY_VERIFIED`
   * rather than treating it as a failure.
   */
  async requestVerificationCode(
    phoneNumberId: string,
    codeMethod: "SMS" | "VOICE",
    language: string,
  ): Promise<Attempted<{ success?: boolean }>> {
    return this.attempt(() =>
      this.call<{ success?: boolean }>(
        "requestVerificationCode",
        "post",
        `/${phoneNumberId}/request_code`,
        { data: { code_method: codeMethod, language } },
      ),
    );
  }

  /** POST /<PHONE_NUMBER_ID>/verify_code */
  async verifyCode(
    phoneNumberId: string,
    code: string,
  ): Promise<Attempted<{ success?: boolean }>> {
    return this.attempt(() =>
      this.call<{ success?: boolean }>("verifyCode", "post", `/${phoneNumberId}/verify_code`, {
        data: { code },
      }),
    );
  }

  /**
   * POST /<PHONE_NUMBER_ID>/register
   *
   * **`pin` is required and is the customer's.** Meta: "If your verified
   * business phone number already has two-step verification enabled, set this
   * value to your number's 6-digit two-step verification PIN." There is no
   * endpoint to read, reset or disable that PIN, so when a number has one we
   * must ask. The signature makes `pin` mandatory precisely so no caller can
   * reintroduce the hardcoded "000000" this replaces.
   *
   * Rate limited to 10 calls per number per 72-hour moving window (error
   * 133016). Callers must not retry blindly; the budget belongs to the
   * customer's number, not to us.
   *
   * Coexistence numbers are already registered and MUST NOT be sent here.
   *
   * https://developers.facebook.com/docs/whatsapp/cloud-api/reference/registration
   */
  async register(
    phoneNumberId: string,
    pin: string,
    dataLocalizationRegion?: string,
  ): Promise<Attempted<{ success?: boolean }>> {
    const data: Record<string, unknown> = { messaging_product: "whatsapp", pin };
    if (dataLocalizationRegion) data.data_localization_region = dataLocalizationRegion;
    return this.attempt(() =>
      this.call<{ success?: boolean }>("register", "post", `/${phoneNumberId}/register`, { data }),
    );
  }

  /**
   * POST /<PHONE_NUMBER_ID>/deregister
   *
   * Requires BOTH `whatsapp_business_management` and
   * `whatsapp_business_messaging`. Frees the number for use with the WhatsApp
   * Business app again.
   */
  async deregister(phoneNumberId: string): Promise<Attempted<{ success?: boolean }>> {
    return this.attempt(() =>
      this.call<{ success?: boolean }>(
        "deregister",
        "post",
        `/${phoneNumberId}/deregister`,
        { data: {} },
      ),
    );
  }

  /**
   * POST /<PHONE_NUMBER_ID> with `{ pin }` - set two-step verification.
   *
   * Provided for completeness and used only when a customer explicitly sets a
   * PIN. Note there is no counterpart to REMOVE two-step verification: Meta
   * publishes no such endpoint. Setting one is therefore a one-way door and
   * callers must say so before doing it.
   */
  async setTwoStepPin(
    phoneNumberId: string,
    pin: string,
  ): Promise<Attempted<{ success?: boolean }>> {
    return this.attempt(() =>
      this.call<{ success?: boolean }>("setTwoStepPin", "post", `/${phoneNumberId}`, {
        data: { pin },
      }),
    );
  }

  // ── 7. Migration between WABAs ─────────────────────────────

  /**
   * Start migrating a number into a destination WABA.
   *   POST /<DESTINATION_WABA_ID>/phone_numbers
   *   { cc, phone_number, migrate_phone_number: true }
   *
   * Returns the NEW `<PHONE_NUMBER_ID>`, which then needs request_code,
   * verify_code and register.
   *
   * Every prerequisite is documented and none is optional: two-step
   * verification disabled on the number, `name_status` APPROVED with no
   * pending change, both WABAs business-verified and review-approved,
   * destination has a payment method and at least one app already subscribed
   * to its webhooks. Numbers in use with the WhatsApp Business app cannot be
   * migrated at all. The flow selector checks all of this before offering
   * migration, so this method is never the place a customer discovers they
   * were ineligible.
   *
   * https://developers.facebook.com/docs/whatsapp/business-management-api/guides/migrating-phone-numbers-between-wabas-programmatically
   */
  async startMigration(params: {
    destinationWabaId: string;
    countryCode: string;
    phoneNumber: string;
  }): Promise<Attempted<{ id: string }>> {
    return this.attempt(() =>
      this.call<{ id: string }>(
        "startMigration",
        "post",
        `/${params.destinationWabaId}/phone_numbers`,
        {
          data: {
            cc: params.countryCode,
            phone_number: params.phoneNumber,
            migrate_phone_number: true,
          },
        },
      ),
    );
  }
}

/** Convenience for the common "build a client for this customer" call. */
export function metaClientFor(accessToken: string, baseUrl?: string): MetaWhatsAppClient {
  return new MetaWhatsAppClient({ accessToken, baseUrl });
}
