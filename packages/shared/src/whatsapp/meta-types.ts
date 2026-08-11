/**
 * Shapes returned by Meta's official WhatsApp and Business Management APIs.
 *
 * Rule applied throughout: **Meta's status-like fields are typed as open
 * string unions, never closed enums.** Meta documents members without ever
 * publishing a complete enumeration (see
 * docs/integrations/whatsapp/01-meta-api-inventory.md sections 5.1 and 8), and
 * they add members without notice. A closed enum here would turn "Meta shipped
 * a new quality rating" into a runtime crash on the customer's channel page.
 *
 * `KnownOr<T>` keeps editor autocomplete for the documented members while
 * still accepting anything Meta sends.
 */

/** Documented members, plus whatever Meta adds next. */
export type KnownOr<T extends string> = T | (string & {});

// ─── Phone number ────────────────────────────────────────────

/**
 * `platform_type`. `CLOUD_API` plus `is_on_biz_app` is exactly Coexistence.
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users/
 */
export type MetaPlatformType = KnownOr<"CLOUD_API" | "ON_PREMISE" | "NOT_APPLICABLE">;

/** `status`. Only `CONNECTED` can send and receive. */
export type MetaPhoneStatus = KnownOr<
  | "CONNECTED"
  | "PENDING"
  | "DELETED"
  | "MIGRATED"
  | "BANNED"
  | "RESTRICTED"
  | "RATE_LIMITED"
  | "FLAGGED"
  | "DISCONNECTED"
  | "UNVERIFIED"
  | "UNKNOWN"
>;

export type MetaCodeVerificationStatus = KnownOr<"VERIFIED" | "NOT_VERIFIED" | "EXPIRED">;

export type MetaNameStatus = KnownOr<
  "APPROVED" | "PENDING_REVIEW" | "DECLINED" | "EXPIRED" | "NONE" | "AVAILABLE_WITHOUT_REVIEW"
>;

export type MetaQualityRating = KnownOr<"GREEN" | "YELLOW" | "RED" | "NA" | "UNKNOWN">;

/**
 * One business phone number as Meta returns it.
 * Fields per https://developers.facebook.com/docs/whatsapp/cloud-api/reference/phone-numbers
 */
export interface MetaPhoneNumber {
  id: string;
  display_phone_number?: string;
  verified_name?: string;
  quality_rating?: MetaQualityRating;
  code_verification_status?: MetaCodeVerificationStatus;
  name_status?: MetaNameStatus;
  status?: MetaPhoneStatus;
  platform_type?: MetaPlatformType;
  /**
   * True when the number is also live in the WhatsApp Business app. Meta only
   * returns this for numbers where it is meaningful, so `undefined` means
   * "not applicable", NOT "false".
   */
  is_on_biz_app?: boolean;
  is_official_business_account?: boolean;
  messaging_limit_tier?: string;
  /** Coexistence numbers are fixed at 20 messages per second by Meta. */
  throughput?: { level?: KnownOr<"STANDARD" | "HIGH" | "NOT_APPLICABLE"> };
  account_mode?: KnownOr<"SANDBOX" | "LIVE">;
  certificate?: string;
  last_onboarded_time?: string;
  webhook_configuration?: MetaWebhookConfiguration;
  health_status?: MetaHealthStatus;
}

export interface MetaWebhookConfiguration {
  /** Max 200 characters, per Meta. */
  override_callback_uri?: string;
  application?: string;
}

// ─── WABA ────────────────────────────────────────────────────

export type MetaAccountReviewStatus = KnownOr<"PENDING" | "APPROVED" | "REJECTED">;

export type MetaBusinessVerificationStatus = KnownOr<
  "verified" | "not_verified" | "pending" | "rejected" | "expired" | "failed"
>;

export interface MetaWaba {
  id: string;
  name?: string;
  currency?: string;
  timezone_id?: string;
  message_template_namespace?: string;
  account_review_status?: MetaAccountReviewStatus;
  business_verification_status?: MetaBusinessVerificationStatus;
  primary_funding_id?: string;
  owner_business_info?: { id?: string; name?: string };
  on_behalf_of_business_info?: { id?: string; name?: string; status?: string };
  health_status?: MetaHealthStatus;
}

/** An app subscribed to a WABA's webhooks. */
export interface MetaSubscribedApp {
  whatsapp_business_api_data?: {
    id?: string;
    name?: string;
    link?: string;
  };
  override_callback_uri?: string;
}

// ─── Health ──────────────────────────────────────────────────

/**
 * `?fields=health_status`. Meta's `possible_solution` is its own remediation
 * text and is shown to customers verbatim rather than paraphrased: Meta knows
 * why it blocked an account and we do not.
 */
export type MetaCanSendMessage = KnownOr<"AVAILABLE" | "LIMITED" | "BLOCKED">;

export interface MetaHealthError {
  error_code?: number;
  error_description?: string;
  possible_solution?: string;
}

export interface MetaHealthEntity {
  entity_type?: KnownOr<"WABA" | "BUSINESS" | "PHONE_NUMBER" | "MESSAGE_TEMPLATE" | "APP">;
  id?: string;
  can_send_message?: MetaCanSendMessage;
  additional_info?: string[];
  errors?: MetaHealthError[];
}

export interface MetaHealthStatus {
  can_send_message?: MetaCanSendMessage;
  entities?: MetaHealthEntity[];
}

// ─── Token introspection ─────────────────────────────────────

/**
 * `GET /debug_token`. `granular_scopes` is how we learn, per customer, which
 * permissions were actually granted and over which assets. We read the WHOLE
 * `target_ids` array; Meta's own example reads only the first, which is where
 * the single-WABA assumption originates.
 */
export interface MetaGranularScope {
  scope: string;
  target_ids?: string[];
}

export interface MetaDebugToken {
  app_id?: string;
  application?: string;
  type?: string;
  is_valid?: boolean;
  scopes?: string[];
  granular_scopes?: MetaGranularScope[];
  expires_at?: number;
  data_access_expires_at?: number;
  user_id?: string;
}

// ─── Embedded Signup ─────────────────────────────────────────

/**
 * The `WA_EMBEDDED_SIGNUP` message event, as posted to the opener window.
 *
 * `event` is deliberately an open string: Embedded Signup v2 is deprecated on
 * 2026-10-15 and v4 may introduce completion events this build has never seen.
 * Code that switches on it must have a default branch that fails loudly rather
 * than silently treating an unknown completion as a failure.
 */
export type EmbeddedSignupEvent = KnownOr<
  "FINISH" | "FINISH_ONLY_WABA" | "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING" | "CANCEL"
>;

/** Screens a customer can abandon on. Used only for drop-off diagnostics. */
export type EmbeddedSignupStep = KnownOr<
  | "BUSINESS_ACCOUNT_SELECTION"
  | "WABA_PHONE_PROFILE_PICKER"
  | "WHATSAPP_BUSINESS_PROFILE_SETUP"
  | "PHONE_NUMBER_SETUP"
  | "PHONE_NUMBER_VERIFICATION"
  | "PERMISSIONS"
>;

export interface EmbeddedSignupPayload {
  type: "WA_EMBEDDED_SIGNUP";
  event: EmbeddedSignupEvent;
  version?: number;
  data?: {
    phone_number_id?: string;
    waba_id?: string;
    /** The Business Portfolio ID. Without it no portfolio inspection is possible. */
    business_id?: string;
    /** Present in the multi-WABA case. */
    waba_ids?: string[];
    current_step?: EmbeddedSignupStep;
    error_message?: string;
  };
}

// ─── Meta error codes we branch on ───────────────────────────

/**
 * Only codes whose handling actually DIFFERS live here. A generic error is
 * reported with Meta's own message; these five change what we do next.
 */
export const META_ERROR = {
  /** Registration: wrong two-step verification PIN. Ask the customer for it. */
  INCORRECT_PIN: 133005,
  /** Registration: number not verified yet. Verification must run first. */
  NOT_VERIFIED: 133006,
  /** Number is not registered. Registration must run before sending. */
  NOT_REGISTERED: 133010,
  /**
   * Registration rate limit: 10 requests per number per 72-hour moving window.
   * Retrying makes this strictly worse, so it stops the pipeline.
   */
  REGISTER_RATE_LIMIT: 133016,
  /** `request_code` on an already-verified number. A success for us. */
  ALREADY_VERIFIED: 136024,
} as const;
