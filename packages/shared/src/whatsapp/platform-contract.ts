/**
 * The SYSTEM_ADMIN console contract for GOTCHA's own WhatsApp alerts number
 * (2026-11-15, PLAN: release-next-kit/platform-whatsapp/PLAN.md sections 3, 5,
 * 6, 7). Hosted in auth under /api/system/platform-whatsapp; every route is
 * authenticate + requireSystemAdmin(), so any other caller gets 401/403.
 *
 *   GET    /api/system/platform-whatsapp                                   -> PlatformWhatsAppStatus
 *   POST   /api/system/platform-whatsapp/connect          ConnectBody      -> PlatformWhatsAppStatus (201)
 *   POST   /api/system/platform-whatsapp/recheck                           -> PlatformWhatsAppStatus
 *   POST   /api/system/platform-whatsapp/disconnect       DisconnectBody   -> PlatformWhatsAppStatus
 *   GET    /api/system/platform-whatsapp/templates                         -> { data: PlatformTemplateView[] }
 *   POST   /api/system/platform-whatsapp/templates/sync                    -> { data: PlatformTemplateView[] }
 *   PUT    /api/system/platform-whatsapp/templates/:eventType/:lang  { body }   -> { data: PlatformTemplateView }
 *   POST   /api/system/platform-whatsapp/templates/:eventType/:lang/submit -> { data: PlatformTemplateView }
 *   PUT    /api/system/platform-whatsapp/alerts/:eventType        { enabled }   -> { data: PlatformTemplateView }
 *
 * `:eventType` is URL-encoded (it contains dots). `:lang` is "he" or "en".
 * Errors are `{ error: PlatformWhatsAppErrorCode, message: string, meta?: { code?: number; message?: string } }`.
 * No response ever carries the access token or the PIN.
 */
import type { EmbeddedSignupLaunch } from "./embedded-signup";
import type { TemplateLocale, PlatformTemplateCategory } from "./platform-templates";

export const PLATFORM_SENDER_STATUSES = ["CONNECTED", "PENDING_WEBHOOK", "TOKEN_INVALID", "DISCONNECTED"] as const;
export type PlatformSenderStatusValue = (typeof PLATFORM_SENDER_STATUSES)[number];

/** Meta's template statuses plus our NOT_SUBMITTED. */
export const PLATFORM_TEMPLATE_STATUSES = [
  "NOT_SUBMITTED", "PENDING", "APPROVED", "REJECTED", "PAUSED", "DISABLED", "IN_APPEAL", "PENDING_DELETION",
] as const;
export type PlatformTemplateStatusValue = (typeof PLATFORM_TEMPLATE_STATUSES)[number];

export interface PlatformWhatsAppStatus {
  status: PlatformSenderStatusValue;
  /** Where sends come from right now: the console's row, the env pair, or nowhere. */
  source: "db" | "env" | "none";
  /** PLATFORM_WHATSAPP_PHONE_NUMBER_ID and _ACCESS_TOKEN are both set (overridden when source is "db"). */
  envPresent: boolean;
  number: {
    display: string | null;
    verifiedName: string | null;
    phoneNumberId: string;
    wabaId: string | null;
    qualityRating: string | null;
    messagingLimitTier: string | null;
  } | null;
  connectedAt: string | null;
  connectedBy: { id: string; name: string | null } | null;
  disconnectedAt: string | null;
  /** The code part of lastError, e.g. "TOKEN_INVALID", "SUBSCRIBE_FAILED". Read this, never parse lastError. */
  lastErrorCode: string | null;
  lastError: string | null;
  /** The same launch object the tenant flow uses: hand it to the existing ES launcher. */
  launch: EmbeddedSignupLaunch;
}

export interface ConnectBody {
  /** The FB.login popup code. */
  code: string;
  /** From the ES session-info message, when the dialog sent it. */
  wabaId?: string;
  phoneNumberId?: string;
}

export interface DisconnectBody {
  /** Also deregister the number from the Cloud API (retire it). Default false: local unlink + unsubscribe. */
  deregister?: boolean;
}

export interface PlatformTemplateLanguageView {
  /** The body in effect (submitted, or the code default before the first submit). */
  body: string;
  /** An edit saved but not yet submitted; null when none. */
  draftBody: string | null;
  status: PlatformTemplateStatusValue;
  /** Meta's rejected_reason, e.g. INVALID_FORMAT. */
  rejectedReason: string | null;
  metaTemplateId: string | null;
  submittedAt: string | null;
  lastSyncedAt: string | null;
}

export interface PlatformTemplateView {
  eventType: string;
  name: string;
  category: PlatformTemplateCategory;
  parameterCount: number;
  buttons: { url: boolean; quickReplies: number; copyCode: boolean };
  /** Whether this template's alert is switched on (for a non-toggleable one: its governing alert's switch, or true for verification). */
  alertEnabled: boolean;
  /** Whether the console shows a switch for it. */
  toggleable: boolean;
  /** Whether the body may be edited (AUTHENTICATION: no). */
  editable: boolean;
  /** Both languages APPROVED and a number connected: what a switch-on needs. */
  canEnable: boolean;
  languages: Record<TemplateLocale, PlatformTemplateLanguageView>;
}

export const PLATFORM_WHATSAPP_ERRORS = {
  choose_one_number: 422,
  number_belongs_to_workspace: 409,
  waba_belongs_to_workspace: 409,
  number_is_platform: 409,
  template_body_invalid: 422,
  template_not_editable: 405,
  meta_edit_limit: 409,
  template_not_approved: 409,
  no_platform_number: 409,
  unknown_template: 404,
  code_exchange_failed: 400,
  no_waba: 400,
  no_phone_numbers: 400,
  platform_store_unavailable: 503,
  meta_error: 502,
} as const;
export type PlatformWhatsAppErrorCode = keyof typeof PLATFORM_WHATSAPP_ERRORS;
