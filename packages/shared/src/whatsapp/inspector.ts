/**
 * The Meta Inspector.
 *
 * Phase 3 of the WhatsApp redesign: before any onboarding flow is launched, and
 * before anything is written anywhere, look at what the customer ACTUALLY has
 * at Meta and return a structured diagnostic model. Phase 4's flow selector
 * then reads that model and nothing else.
 *
 * Three design rules, each of which fixes a specific failure in what came
 * before:
 *
 *  1. **Read-only.** The inspector performs no POST, no subscription, no
 *     registration. It can be run at any time, on any tenant, including on a
 *     healthy connected number, without consequence. The previous flow could
 *     not tell you what was wrong without trying to fix it.
 *
 *  2. **Partial results beat exceptions.** A customer with five WABAs where we
 *     can read four is a customer we can still help. Every remote call goes
 *     through `Attempted<T>`; a failure becomes a recorded, attributed entry in
 *     `errors[]` and the sweep continues.
 *
 *  3. **It never hides what it could not check.** `degraded` and
 *     `missingPermissions[]` are first-class output. An inspector that quietly
 *     narrows its own scope produces a confident WRONG flow selection, which is
 *     worse than an honest failure - the customer follows a path that cannot
 *     work and blames the product.
 *
 * Reference: docs/integrations/whatsapp/01-meta-api-inventory.md
 */

import {
  MetaWhatsAppClient,
  type Attempted,
  type MetaApiError,
} from "./meta-client";
import type {
  MetaHealthStatus,
  MetaPhoneNumber,
  MetaWaba,
  MetaPlatformType,
} from "./meta-types";

// ─── Diagnostic model ────────────────────────────────────────

/** What kind of thing a number is, in OUR terms rather than Meta's. */
export type NumberKind =
  /** Live on Cloud API, not in the WhatsApp Business app. */
  | "CLOUD_API"
  /** Live on Cloud API AND in the WhatsApp Business app. Coexistence. */
  | "COEXISTENCE"
  /** Exists on the WABA but has never been registered for Cloud API. */
  | "UNREGISTERED"
  /** On-premise API. Legacy, and not something we onboard. */
  | "ON_PREMISE"
  /** Meta returned a platform_type this build has not seen. */
  | "UNKNOWN";

/**
 * Something standing between this number and working messaging.
 *
 * `customerActionable` is the important field: it splits "the customer must do
 * this, and we should say so plainly" from "we will handle this automatically".
 * Getting that split wrong is what produces both of the bad onboarding
 * experiences - asking the customer to do something we could have done, and
 * silently failing at something only they can do.
 */
export interface Blocker {
  code: string;
  /** Plain sentence, no Meta jargon. Shown to the customer. */
  message: string;
  customerActionable: boolean;
  /** Meta's own remediation text, when Meta gave us one. Never paraphrased. */
  metaSolution?: string;
  metaErrorCode?: number;
}

export interface InspectedNumber {
  phoneNumberId: string;
  displayPhoneNumber?: string;
  verifiedName?: string;
  wabaId: string;
  businessPortfolioId?: string;

  // Raw Meta facts
  platformType?: MetaPlatformType;
  isOnBizApp: boolean;
  status?: string;
  codeVerificationStatus?: string;
  nameStatus?: string;
  qualityRating?: string;
  throughputLevel?: string;
  messagingLimitTier?: string;

  // Derived
  kind: NumberKind;
  /** Our app is subscribed to this number's WABA. Inbound can reach us. */
  webhookSubscribed: boolean;
  /** Another platform has claimed this number's webhooks. A diagnosis. */
  webhookOverrideUri?: string;

  // GOTCHA-side facts, supplied by the caller
  connectedToThisTenant: boolean;
  connectedToAnotherTenant: boolean;

  health?: MetaHealthStatus;
  blockers: Blocker[];
}

export interface InspectedWaba {
  wabaId: string;
  name?: string;
  businessPortfolioId?: string;
  accountReviewStatus?: string;
  businessVerificationStatus?: string;
  /** Whether we could read the WABA at all. False means a permission gap. */
  readable: boolean;
  /** Our app is subscribed to this WABA's webhooks. */
  appSubscribed: boolean;
  hasPaymentMethod: boolean;
  numberIds: string[];
  health?: MetaHealthStatus;
}

export interface InspectedPortfolio {
  portfolioId: string;
  name?: string;
  /** Portfolio-level verification. Decides the registered-number cap. */
  businessVerified: boolean;
  wabaIds: string[];
  /**
   * Meta's registered-number cap: 2 before Business Verification, 20 after.
   * Derived from `businessVerified`, and null when we could not read the
   * portfolio at all rather than guessed at.
   */
  registeredNumberCap: number | null;
}

export interface InspectionError {
  /** Which client method failed. */
  operation: string;
  /** Which Meta node it was about. */
  subject?: string;
  message: string;
  metaErrorCode?: number;
  isPermissionError: boolean;
}

export interface MetaInspection {
  inspectedAt: string;
  /** Permissions the token actually carries, read from debug_token. */
  grantedScopes: string[];
  /** Permissions we need and did not get. Named, so the UI can say which. */
  missingPermissions: string[];
  /** True when some part of the sweep could not be completed. */
  degraded: boolean;
  degradedReasons: string[];

  portfolios: InspectedPortfolio[];
  wabas: InspectedWaba[];
  numbers: InspectedNumber[];
  errors: InspectionError[];
}

/** Permissions without which the inspector cannot do its job at all. */
export const REQUIRED_SCOPES = [
  "whatsapp_business_management",
  "whatsapp_business_messaging",
] as const;

/** Improves the sweep; its absence degrades rather than blocks. See Phase 2. */
export const ENRICHING_SCOPES = ["business_management"] as const;

// ─── Inputs ──────────────────────────────────────────────────

export interface InspectOptions {
  client: MetaWhatsAppClient;
  appId: string;
  appSecret: string;
  /** Our Meta app id, to recognise ourselves in a subscribed_apps list. */
  ourAppId: string;
  /**
   * Numbers GOTCHA already knows about: `phone_number_id -> tenantId`. Passed
   * in rather than queried so the inspector stays free of a database
   * dependency and is trivially testable.
   */
  knownNumbers?: Map<string, string>;
  /** The tenant we are inspecting on behalf of. */
  tenantId: string;
  /**
   * Portfolio and WABA hints from the Embedded Signup payload. Real inputs,
   * not a fallback: `business_id` is only ever available from that payload.
   */
  hints?: { businessPortfolioId?: string; wabaIds?: string[] };
  /** Health calls double the request count; off for fast pre-flight sweeps. */
  includeHealth?: boolean;
}

// ─── Implementation ──────────────────────────────────────────

function recordError(
  errors: InspectionError[],
  operation: string,
  subject: string | undefined,
  err: MetaApiError,
): void {
  errors.push({
    operation,
    subject,
    message: err.message,
    metaErrorCode: err.code,
    isPermissionError: err.isPermissionError,
  });
}

function unwrap<T>(
  attempted: Attempted<T>,
  errors: InspectionError[],
  operation: string,
  subject?: string,
): T | null {
  if (attempted.ok) return attempted.value;
  recordError(errors, operation, subject, attempted.error);
  return null;
}

/**
 * Classify a number from the two fields that actually decide it.
 *
 * `is_on_biz_app` is `undefined` for numbers where it does not apply, which is
 * NOT the same as `false`; treating the two as equal would misclassify every
 * number Meta declines to answer for.
 */
export function classifyNumber(phone: MetaPhoneNumber): NumberKind {
  const platform = phone.platform_type;
  const onBizApp = phone.is_on_biz_app === true;

  if (platform === "CLOUD_API") return onBizApp ? "COEXISTENCE" : "CLOUD_API";
  if (platform === "ON_PREMISE") return "ON_PREMISE";
  if (platform === "NOT_APPLICABLE" || platform == null) {
    // Meta reports NOT_APPLICABLE for a number that exists on the WABA but was
    // never registered for an API. That is Scenario A's starting state.
    return "UNREGISTERED";
  }
  return "UNKNOWN";
}

/**
 * Turn Meta's health response into blockers.
 *
 * Meta's `possible_solution` is carried through untouched. It is written by
 * the team that blocked the account and is invariably more accurate and more
 * actionable than anything we could infer from an error code.
 */
function blockersFromHealth(health: MetaHealthStatus | undefined): Blocker[] {
  if (!health) return [];
  const out: Blocker[] = [];
  for (const entity of health.entities || []) {
    if (entity.can_send_message === "AVAILABLE") continue;
    for (const err of entity.errors || []) {
      out.push({
        code: `META_HEALTH_${err.error_code ?? "UNKNOWN"}`,
        message: err.error_description || "Meta reported a problem with this account.",
        // Meta's health errors are almost always business-side: verification,
        // policy, payment. Treating them as ours would hide the one person
        // who can actually resolve them.
        customerActionable: true,
        metaSolution: err.possible_solution,
        metaErrorCode: err.error_code,
      });
    }
  }
  return out;
}

/** Blockers derivable from the number's own fields, without a health call. */
function blockersFromFields(
  phone: MetaPhoneNumber,
  kind: NumberKind,
  webhookSubscribed: boolean,
  connectedToAnotherTenant: boolean,
): Blocker[] {
  const out: Blocker[] = [];

  if (connectedToAnotherTenant) {
    out.push({
      code: "CONNECTED_ELSEWHERE",
      message:
        "This number is already connected to a different GOTCHA workspace. " +
        "Disconnect it there first, then add it here.",
      customerActionable: true,
    });
  }

  if (kind === "ON_PREMISE") {
    out.push({
      code: "ON_PREMISE",
      message:
        "This number runs on WhatsApp's older on-premise system, which GOTCHA does not connect to.",
      customerActionable: true,
    });
  }

  if (phone.status === "BANNED" || phone.status === "RESTRICTED") {
    out.push({
      code: `PHONE_${phone.status}`,
      message:
        phone.status === "BANNED"
          ? "WhatsApp has banned this number, so it cannot send or receive messages."
          : "WhatsApp has restricted this number, so messaging is limited.",
      customerActionable: true,
    });
  }

  if (phone.code_verification_status === "NOT_VERIFIED") {
    out.push({
      code: "NOT_VERIFIED",
      message: "This number still needs to be verified with a code from WhatsApp.",
      customerActionable: true,
    });
  }

  if (phone.name_status === "DECLINED") {
    out.push({
      code: "NAME_DECLINED",
      message:
        "WhatsApp declined the display name on this number. Choose a different one in your " +
        "WhatsApp Business settings.",
      customerActionable: true,
    });
  }

  if (!webhookSubscribed) {
    // Ours to fix, and the single most common reason a number looks connected
    // while no message ever arrives.
    out.push({
      code: "WEBHOOK_NOT_SUBSCRIBED",
      message: "Incoming messages are not being delivered to GOTCHA yet.",
      customerActionable: false,
    });
  }

  const override = phone.webhook_configuration?.override_callback_uri;
  if (override) {
    out.push({
      code: "WEBHOOK_OVERRIDDEN",
      message:
        "Another platform is currently receiving this number's messages. " +
        "Disconnect it there before connecting it to GOTCHA.",
      customerActionable: true,
    });
  }

  return out;
}

/**
 * Run the full sweep.
 *
 * Never throws for a Meta-side problem. It throws only if `debug_token` itself
 * fails, because at that point we do not know what the token can do and every
 * subsequent call would be a guess.
 */
export async function inspectMetaAssets(opts: InspectOptions): Promise<MetaInspection> {
  const {
    client,
    appId,
    appSecret,
    ourAppId,
    knownNumbers = new Map<string, string>(),
    tenantId,
    hints,
    includeHealth = true,
  } = opts;

  const errors: InspectionError[] = [];
  const degradedReasons: string[] = [];

  // ── Step 1: what did this token actually get ──
  const debug = await client.debugToken(appId, appSecret);
  const grantedScopes = MetaWhatsAppClient.grantedScopes(debug);

  const missingPermissions = [...REQUIRED_SCOPES, ...ENRICHING_SCOPES].filter(
    (s) => !grantedScopes.includes(s),
  );
  for (const missing of missingPermissions) {
    degradedReasons.push(
      (REQUIRED_SCOPES as readonly string[]).includes(missing)
        ? `Required permission "${missing}" was not granted.`
        : `Optional permission "${missing}" was not granted, so existing accounts may not all be visible.`,
    );
  }

  // ── Step 2: which assets are in scope ──
  // Three sources, deliberately unioned rather than ranked. The signup payload
  // knows what the customer just picked; the token knows what we may touch;
  // the portfolio knows what else exists. Any one alone leaves a real gap.
  const grantedWabaIds = MetaWhatsAppClient.grantedTargets(debug, "whatsapp_business_management");
  const grantedPortfolioIds = MetaWhatsAppClient.grantedTargets(debug, "business_management");

  const portfolioIds = new Set<string>(grantedPortfolioIds);
  if (hints?.businessPortfolioId) portfolioIds.add(hints.businessPortfolioId);

  const wabaIds = new Set<string>(grantedWabaIds);
  for (const id of hints?.wabaIds || []) wabaIds.add(id);

  // ── Step 3: portfolios, and the WABAs they reveal ──
  const portfolios: InspectedPortfolio[] = [];
  for (const portfolioId of portfolioIds) {
    const portfolioWabaIds = new Set<string>();
    let anyReadable = false;

    const owned = await client.ownedWabas(portfolioId);
    const ownedList = unwrap(owned, errors, "ownedWabas", portfolioId);
    if (ownedList) {
      anyReadable = true;
      for (const w of ownedList) {
        portfolioWabaIds.add(w.id);
        wabaIds.add(w.id);
      }
    }

    const clients = await client.clientWabas(portfolioId);
    const clientList = unwrap(clients, errors, "clientWabas", portfolioId);
    if (clientList) {
      anyReadable = true;
      for (const w of clientList) {
        portfolioWabaIds.add(w.id);
        wabaIds.add(w.id);
      }
    }

    if (!anyReadable) {
      degradedReasons.push(
        `Could not list the WhatsApp accounts in business portfolio ${portfolioId}.`,
      );
    }

    // Portfolio verification is only observable through its WABAs'
    // `business_verification_status`, resolved in step 4. Left null here and
    // filled in below rather than assumed.
    portfolios.push({
      portfolioId,
      businessVerified: false,
      wabaIds: [...portfolioWabaIds],
      registeredNumberCap: anyReadable ? null : null,
    });
  }

  // ── Step 4: WABAs ──
  const wabas: InspectedWaba[] = [];
  const numbers: InspectedNumber[] = [];

  for (const wabaId of wabaIds) {
    const wabaResult = await client.getWaba(wabaId);
    const waba: MetaWaba | null = unwrap(wabaResult, errors, "getWaba", wabaId);

    // Subscription state is read, not assumed. This is the only evidence that
    // inbound messages can reach us, so it is checked per WABA, every sweep.
    const subsResult = await client.listSubscribedApps(wabaId);
    const subs = unwrap(subsResult, errors, "listSubscribedApps", wabaId);
    const appSubscribed = (subs || []).some(
      (s) => s.whatsapp_business_api_data?.id === ourAppId,
    );
    const wabaOverride = (subs || []).find((s) => s.override_callback_uri)?.override_callback_uri;

    let wabaHealth: MetaHealthStatus | undefined;
    if (includeHealth) {
      const h = await client.getHealthStatus(wabaId);
      wabaHealth = unwrap(h, errors, "getHealthStatus", wabaId) || undefined;
    }

    const phonesResult = await client.listPhoneNumbers(wabaId);
    const phones = unwrap(phonesResult, errors, "listPhoneNumbers", wabaId) || [];

    const portfolioId =
      waba?.owner_business_info?.id || waba?.on_behalf_of_business_info?.id || undefined;

    wabas.push({
      wabaId,
      name: waba?.name,
      businessPortfolioId: portfolioId,
      accountReviewStatus: waba?.account_review_status,
      businessVerificationStatus: waba?.business_verification_status,
      readable: waba != null,
      appSubscribed,
      hasPaymentMethod: Boolean(waba?.primary_funding_id),
      numberIds: phones.map((p) => p.id),
      health: wabaHealth,
    });

    for (const phone of phones) {
      const kind = classifyNumber(phone);
      const owner = knownNumbers.get(phone.id);
      const connectedToThisTenant = owner === tenantId;
      const connectedToAnotherTenant = owner != null && owner !== tenantId;

      let health: MetaHealthStatus | undefined;
      if (includeHealth) {
        const h = await client.getHealthStatus(phone.id);
        health = unwrap(h, errors, "getHealthStatus", phone.id) || undefined;
      }

      numbers.push({
        phoneNumberId: phone.id,
        displayPhoneNumber: phone.display_phone_number,
        verifiedName: phone.verified_name,
        wabaId,
        businessPortfolioId: portfolioId,
        platformType: phone.platform_type,
        isOnBizApp: phone.is_on_biz_app === true,
        status: phone.status,
        codeVerificationStatus: phone.code_verification_status,
        nameStatus: phone.name_status,
        qualityRating: phone.quality_rating,
        throughputLevel: phone.throughput?.level,
        messagingLimitTier: phone.messaging_limit_tier,
        kind,
        webhookSubscribed: appSubscribed,
        webhookOverrideUri: phone.webhook_configuration?.override_callback_uri || wabaOverride,
        connectedToThisTenant,
        connectedToAnotherTenant,
        health,
        blockers: [
          ...blockersFromFields(phone, kind, appSubscribed, connectedToAnotherTenant),
          ...blockersFromHealth(health),
        ],
      });
    }
  }

  // ── Step 5: resolve portfolio verification from its WABAs ──
  // A portfolio is verified when any WABA under it reports verification; that
  // status is a property of the business, and Meta surfaces it on the WABA.
  for (const portfolio of portfolios) {
    const own = wabas.filter(
      (w) => w.businessPortfolioId === portfolio.portfolioId || portfolio.wabaIds.includes(w.wabaId),
    );
    const readable = own.filter((w) => w.readable);
    if (readable.length === 0) continue;
    portfolio.businessVerified = readable.some(
      (w) => w.businessVerificationStatus === "verified",
    );
    // 2 registered numbers before Business Verification, 20 after. Meta raises
    // this itself; we only report where the customer stands.
    portfolio.registeredNumberCap = portfolio.businessVerified ? 20 : 2;
    if (!portfolio.name) {
      portfolio.name = readable.find((w) => w.name)?.name;
    }
  }

  return {
    inspectedAt: new Date().toISOString(),
    grantedScopes,
    missingPermissions,
    degraded: degradedReasons.length > 0 || errors.length > 0,
    degradedReasons,
    portfolios,
    wabas,
    numbers,
    errors,
  };
}
