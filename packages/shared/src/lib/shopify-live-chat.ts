/**
 * Shopify Live Chat - shared domain module.
 *
 * One place for everything three different processes need to agree on:
 *
 *   - services/ai            → public storefront API + AI product tools
 *   - services/conversation  → visitor socket rooms + agent product sends
 *   - services/incoming-worker → persisting structured commerce messages
 *
 * Design rules baked in here (not re-litigated at each call site):
 *
 *   1. The storefront is UNTRUSTED. It supplies a public channel key, an
 *      origin, a page URL and a page type. Nothing else it says about
 *      money, stock, identity or tenancy is believed.
 *   2. Shopify stays the source of truth for products. What we persist on
 *      a message is a *display snapshot* plus the references needed to
 *      re-resolve the truth (shop domain, product id, variant id).
 *   3. Merchant "branding" is a set of validated design TOKENS. No CSS,
 *      no HTML, no arbitrary URLs.
 *   4. Visitor sessions are opaque, signed, and carry the tenant so no
 *      browser ever names its own tenant.
 */

import {
  defaultShopifyChatUx,
  normalizeShopifyChatUx,
  migrateLegacyWelcome,
  type ShopifyChatUx,
} from "./shopify-chat-ux";

import {
  normalizeRecommendationSet,
  type ProductRecommendationSet,
  type ProviderProductRecord,
  type RecommendationMoney,
  type RecommendedProduct,
} from "./product-recommendations";

import crypto from "crypto";

// ─── Channel constants ───────────────────────────────────────

export const SHOPIFY_LIVE_CHAT_CHANNEL = "SHOPIFY_LIVE_CHAT" as const;

/** Structured commerce message types (Message.messageType values). */
export const SHOPIFY_MESSAGE_TYPES = {
  PRODUCT: "shopify_product",
  PRODUCT_CAROUSEL: "shopify_product_carousel",
  PRODUCT_MEDIA: "shopify_product_media",
  CART_ACTION: "shopify_cart_action",
} as const;

export type ShopifyMessageType =
  (typeof SHOPIFY_MESSAGE_TYPES)[keyof typeof SHOPIFY_MESSAGE_TYPES];

const SHOPIFY_MESSAGE_TYPE_VALUES: string[] = Object.values(SHOPIFY_MESSAGE_TYPES);

export function isShopifyCommerceMessageType(value: unknown): value is ShopifyMessageType {
  return typeof value === "string" && SHOPIFY_MESSAGE_TYPE_VALUES.includes(value);
}

/**
 * Hard cap on products in a single carousel message. Chat is not a
 * collection page: past ~5 the customer scrolls instead of choosing, and
 * every extra card is another image on a storefront we promised not to
 * slow down.
 */
export const MAX_CAROUSEL_ITEMS = 5;
export const DEFAULT_CAROUSEL_ITEMS = 3;

/** Message body hard cap for visitor-authored text (pre-sanitizer). */
export const MAX_VISITOR_MESSAGE_CHARS = 2000;

/** How long a signed visitor session stays valid without renewal. */
export const VISITOR_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

// ─── Shop domain ─────────────────────────────────────────────

const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/**
 * Normalize whatever the merchant/integration stored into a bare
 * `*.myshopify.com` host. Returns null when it is not a plausible shop
 * domain - callers treat null as "not connected", never as "allow".
 */
export function normalizeShopDomain(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let v = raw.trim().toLowerCase();
  if (!v) return null;
  v = v.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
  if (!SHOP_DOMAIN_RE.test(v)) return null;
  return v;
}

/**
 * Origins a storefront request is allowed to arrive from for a given shop.
 *
 * Shopify serves the storefront from the merchant's custom domain, not
 * from `*.myshopify.com`, so the shop domain alone is never enough. The
 * merchant declares their storefront domains in channel config; we accept
 * those plus the canonical myshopify host.
 */
export function buildAllowedOrigins(
  shopDomain: string | null,
  storefrontDomains: string[] = [],
): string[] {
  const out = new Set<string>();
  if (shopDomain) out.add(`https://${shopDomain}`);
  for (const d of storefrontDomains) {
    const host = normalizeStorefrontDomain(d);
    if (host) out.add(`https://${host}`);
  }
  return [...out];
}

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** A merchant-declared storefront host (custom domain). No scheme, no path. */
export function normalizeStorefrontDomain(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let v = raw.trim().toLowerCase();
  if (!v) return null;
  v = v.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
  if (v.length > 253) return null;
  if (!HOST_RE.test(v)) return null;
  return v;
}

/**
 * Origin check for the public bootstrap. Exact origin match only - no
 * suffix matching (`evil-myshop.com` must never satisfy `myshop.com`) and
 * no wildcard.
 */
export function isOriginAllowed(origin: unknown, allowedOrigins: string[]): boolean {
  if (typeof origin !== "string" || !origin) return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") {
    // Allow http only for localhost during development previews.
    const isLocal = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    if (!(isLocal && process.env.NODE_ENV !== "production")) return false;
  }
  const normalized = `${parsed.protocol}//${parsed.host}`;
  return allowedOrigins.some((a) => a.toLowerCase() === normalized.toLowerCase());
}

// ─── Channel configuration ───────────────────────────────────

export type WidgetPosition = "right" | "left";
export type WidgetLanguage = "auto" | "en" | "he";
export type WidgetDirection = "auto" | "ltr" | "rtl";
export type OfflineBehavior = "ai" | "form" | "message_only";

export interface ShopifyLiveChatAppearance {
  /** Primary brand colour - hex only. */
  primaryColor: string;
  /** Text/icon colour used on top of primaryColor - hex only. */
  contrastColor: string;
  /** Store logo shown in the welcome header. Must be https. */
  logoUrl: string | null;
  /** Assistant avatar shown next to replies. Must be https. */
  avatarUrl: string | null;
  /** Launcher glyph. A small named set - never merchant markup. */
  launcherIcon: "chat" | "sparkle" | "bag" | "question";
  launcherPosition: WidgetPosition;
  /** Corner radius token, clamped to a safe range. */
  cornerRadius: number;
  language: WidgetLanguage;
  direction: WidgetDirection;
  showPoweredBy: boolean;
}

export interface ShopifyLiveChatWelcome {
  headline: string;
  subline: string;
  /** Assistant/store display name in the header. */
  assistantName: string;
  suggestedQuestions: string[];
}

export interface ShopifyLiveChatHours {
  // enabled / timezone / week used to live here, duplicating the tenant's
  // business hours with an incompatible shape. WHEN the store is open is
  // now answered in exactly one place (lib/business-hours.ts); what the
  // WIDGET says while it is closed is storefront copy, and stays here.
  offlineBehavior: OfflineBehavior;
  offlineMessage: string;
  /** Offline lead form asks for these fields only. */
  offlineFormFields: Array<"name" | "email" | "message">;
  offlineConsentText: string;
}

export interface ShopifyLiveChatRouting {
  /**
   * Show "talk to a human" affordance in the widget.
   *
   * Genuinely per-channel: a storefront widget may reasonably offer a
   * person when an unattended channel does not.
   */
  allowHumanHandoff: boolean;
  /** Whether a human may hand the conversation back to the AI employee. */
  allowReturnToAi: boolean;
}

export interface ShopifyLiveChatCommerce {
  /** Master switch for product cards / carousels / add-to-cart. */
  productMessagingEnabled: boolean;
  /** Cards the AI may put in one carousel. */
  carouselSize: number;
  /** Allow Add to Cart from chat. View Product stays available regardless. */
  addToCartEnabled: boolean;
  /**
   * Send DRAFT/ARCHIVED products. Off by default - a merchant who turns
   * this on gets an explicit "not published" badge on the card.
   */
  allowUnpublishedProducts: boolean;
}

export interface ShopifyLiveChatPrivacy {
  /**
   * Never on by default. Cart contents and logged-in Shopify customer
   * identity are only read when the merchant opts in AND the storefront
   * bridge can supply a server-verifiable signal.
   */
  useCartContext: boolean;
  /** Show a consent line before the offline lead form. */
  requireOfflineConsent: boolean;
}

export interface ShopifyLiveChatInstall {
  /** Merchant-declared storefront hosts (custom domains). */
  storefrontDomains: string[];
  /** Last time a storefront bootstrap succeeded for this channel. */
  lastHeartbeatAt: string | null;
  /** Theme id seen on the last heartbeat - a change hints at a theme swap. */
  lastThemeId: string | null;
  /** Last storefront page that booted the widget (path only, no query). */
  lastSeenPath: string | null;
}

/**
 * Launcher / hero / proactive / sounds / behaviour live in their own
 * module: they are presentation, they change often, and none of them may
 * ever be able to break the channel contract in this file.
 */
export interface ShopifyLiveChatConfig {
  /** Shop the channel is bound to. Immutable after creation. */
  shopDomain: string | null;
  /** TenantIntegration row for slug="shopify" this channel is bound to. */
  tenantIntegrationId: string | null;
  enabled: boolean;
  appearance: ShopifyLiveChatAppearance;
  welcome: ShopifyLiveChatWelcome;
  hours: ShopifyLiveChatHours;
  routing: ShopifyLiveChatRouting;
  commerce: ShopifyLiveChatCommerce;
  privacy: ShopifyLiveChatPrivacy;
  install: ShopifyLiveChatInstall;
  /** Merchant-configurable experience. Normalised on every read. */
  ux: ShopifyChatUx;
}

export const DEFAULT_SUGGESTED_QUESTIONS: string[] = [
  "Which product is right for me?",
  "Can you recommend something for my needs?",
  "What is currently in stock?",
  "Can you help me choose a size?",
];

export function defaultShopifyLiveChatConfig(): ShopifyLiveChatConfig {
  return {
    ux: defaultShopifyChatUx(),
    shopDomain: null,
    tenantIntegrationId: null,
    enabled: false,
    appearance: {
      primaryColor: "#111827",
      contrastColor: "#ffffff",
      logoUrl: null,
      avatarUrl: null,
      launcherIcon: "chat",
      launcherPosition: "right",
      cornerRadius: 20,
      language: "auto",
      direction: "auto",
      showPoweredBy: true,
    },
    welcome: {
      headline: "Hi there",
      subline: "Ask us anything about our products. We are happy to help you choose.",
      assistantName: "Store Assistant",
      suggestedQuestions: [...DEFAULT_SUGGESTED_QUESTIONS],
    },
    hours: {
      offlineBehavior: "ai",
      offlineMessage: "We are away right now. Leave a message and we will get back to you.",
      offlineFormFields: ["name", "email", "message"],
      offlineConsentText: "",
    },
    routing: {
      allowHumanHandoff: true,
      allowReturnToAi: true,
    },
    commerce: {
      productMessagingEnabled: true,
      carouselSize: DEFAULT_CAROUSEL_ITEMS,
      addToCartEnabled: true,
      allowUnpublishedProducts: false,
    },
    privacy: {
      useCartContext: false,
      requireOfflineConsent: true,
    },
    install: {
      storefrontDomains: [],
      lastHeartbeatAt: null,
      lastThemeId: null,
      lastSeenPath: null,
    },
  };
}

// ─── Config validation (design tokens, never CSS) ────────────

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const LAUNCHER_ICONS = ["chat", "sparkle", "bag", "question"] as const;
const OFFLINE_BEHAVIORS: OfflineBehavior[] = ["ai", "form", "message_only"];
const OFFLINE_FIELDS = ["name", "email", "message"] as const;

const MAX_HEADLINE = 60;
const MAX_SUBLINE = 200;
const MAX_ASSISTANT_NAME = 40;
const MAX_QUESTION = 80;
const MAX_QUESTIONS = 5;
const MAX_OFFLINE_MESSAGE = 300;
const MAX_STOREFRONT_DOMAINS = 5;

function hex(raw: unknown, fallback: string): string {
  return typeof raw === "string" && HEX_RE.test(raw.trim()) ? raw.trim().toLowerCase() : fallback;
}

/**
 * Merchant-supplied text is stripped of everything that could become
 * markup or a prompt-injection carrier, then hard-capped. This runs on
 * WRITE so the stored config is already safe for every reader.
 */
export function sanitizeToken(raw: unknown, maxLength: number): string {
  if (typeof raw !== "string") return "";
  return raw
    // Control chars + bidi overrides (RTL spoofing).
    .replace(/[\u0000-\u001F\u007F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, " ")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

/** https-only asset URL. Anything else (javascript:, data:, http:) → null. */
export function sanitizeAssetUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (!HOST_RE.test(u.hostname)) return null;
  return u.toString().slice(0, 1024);
}

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function bool(raw: unknown, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback;
}

function isValidTimezone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const RANGE_RE = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;

function sanitizeWeek(raw: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const day of ["0", "1", "2", "3", "4", "5", "6"]) {
    const entry = (raw as Record<string, unknown>)[day];
    if (!Array.isArray(entry)) continue;
    const ranges = entry
      .filter((r): r is string => typeof r === "string" && RANGE_RE.test(r.trim()))
      .map((r) => r.trim())
      .slice(0, 4);
    if (ranges.length) out[day] = ranges;
  }
  return out;
}

/**
 * Merge an untrusted patch over the current config and return a fully
 * normalized object. Every field is validated; unknown fields are dropped.
 * `shopDomain` / `tenantIntegrationId` are NOT patchable here - binding a
 * channel to a different store is a create-time decision (see §8: a
 * product reference must never cross stores).
 */
export function normalizeShopifyLiveChatConfig(
  raw: unknown,
  base: ShopifyLiveChatConfig = defaultShopifyLiveChatConfig(),
): ShopifyLiveChatConfig {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const a = (src.appearance ?? {}) as Record<string, any>;
  const w = (src.welcome ?? {}) as Record<string, any>;
  const h = (src.hours ?? {}) as Record<string, any>;
  const r = (src.routing ?? {}) as Record<string, any>;
  const c = (src.commerce ?? {}) as Record<string, any>;
  const p = (src.privacy ?? {}) as Record<string, any>;
  const i = (src.install ?? {}) as Record<string, any>;

  // Upgrade-on-read: a channel written before any of this existed gets
  // the defaults, and a half-written blob gets the missing halves. No
  // reader downstream has to guard for an absent nested field.

  const questions = Array.isArray(w.suggestedQuestions)
    ? w.suggestedQuestions
        .map((q: unknown) => sanitizeToken(q, MAX_QUESTION))
        .filter((q: string) => q.length > 0)
        .slice(0, MAX_QUESTIONS)
    : base.welcome.suggestedQuestions;

  let ux = normalizeShopifyChatUx(src.ux, base.ux);
  // Fold the four legacy welcome sources into the canonical one. Runs on
  // every read so an old channel needs no migration job, and a value the
  // merchant has already saved under ux.welcome always wins over a stale
  // legacy field. After the next save only the canonical shape persists.
  ux = {
    ...ux,
    welcome: migrateLegacyWelcome({
      ux: src.ux ?? base.ux,
      appearance: { logoUrl: a.logoUrl ?? base.appearance.logoUrl, avatarUrl: a.avatarUrl ?? base.appearance.avatarUrl },
      welcome: {
        headline: w.headline ?? base.welcome.headline,
        subline: w.subline ?? base.welcome.subline,
        assistantName: w.assistantName ?? base.welcome.assistantName,
        suggestedQuestions: questions,
      },
      hero: { avatarUrl: (src.ux as any)?.hero?.avatarUrl ?? null },
    }),
  };

  const domains = Array.isArray(i.storefrontDomains)
    ? Array.from(
        new Set(
          i.storefrontDomains
            .map((d: unknown) => normalizeStorefrontDomain(d))
            .filter((d: string | null): d is string => !!d),
        ),
      ).slice(0, MAX_STOREFRONT_DOMAINS)
    : base.install.storefrontDomains;

  const offlineFields = Array.isArray(h.offlineFormFields)
    ? (h.offlineFormFields.filter((f: unknown) =>
        OFFLINE_FIELDS.includes(f as (typeof OFFLINE_FIELDS)[number]),
      ) as Array<"name" | "email" | "message">)
    : base.hours.offlineFormFields;

  return {
    shopDomain: base.shopDomain,
    tenantIntegrationId: base.tenantIntegrationId,
    ux,
    enabled: bool(src.enabled, base.enabled),
    appearance: {
      primaryColor: hex(a.primaryColor, base.appearance.primaryColor),
      contrastColor: hex(a.contrastColor, base.appearance.contrastColor),
      logoUrl: "logoUrl" in a ? sanitizeAssetUrl(a.logoUrl) : base.appearance.logoUrl,
      avatarUrl: "avatarUrl" in a ? sanitizeAssetUrl(a.avatarUrl) : base.appearance.avatarUrl,
      launcherIcon: LAUNCHER_ICONS.includes(a.launcherIcon)
        ? a.launcherIcon
        : base.appearance.launcherIcon,
      launcherPosition: a.launcherPosition === "left" || a.launcherPosition === "right"
        ? a.launcherPosition
        : base.appearance.launcherPosition,
      cornerRadius: clampInt(a.cornerRadius, 0, 28, base.appearance.cornerRadius),
      language: ["auto", "en", "he"].includes(a.language) ? a.language : base.appearance.language,
      direction: ["auto", "ltr", "rtl"].includes(a.direction)
        ? a.direction
        : base.appearance.direction,
      showPoweredBy: bool(a.showPoweredBy, base.appearance.showPoweredBy),
    },
    welcome: {
      headline: sanitizeToken(w.headline, MAX_HEADLINE) || base.welcome.headline,
      subline: sanitizeToken(w.subline, MAX_SUBLINE) || base.welcome.subline,
      assistantName:
        sanitizeToken(w.assistantName, MAX_ASSISTANT_NAME) || base.welcome.assistantName,
      suggestedQuestions: questions,
    },
    hours: {
      offlineBehavior: OFFLINE_BEHAVIORS.includes(h.offlineBehavior)
        ? h.offlineBehavior
        : base.hours.offlineBehavior,
      offlineMessage:
        sanitizeToken(h.offlineMessage, MAX_OFFLINE_MESSAGE) || base.hours.offlineMessage,
      offlineFormFields: offlineFields.length ? offlineFields : base.hours.offlineFormFields,
      offlineConsentText: "offlineConsentText" in h
        ? sanitizeToken(h.offlineConsentText, MAX_OFFLINE_MESSAGE)
        : base.hours.offlineConsentText,
    },
    routing: {
      // aiAgentId and departmentId used to live here. They are dropped on
      // read rather than migrated: the Main Playbook graph decides who
      // handles a conversation, on this channel as on every other one, so
      // there is nowhere for an old value to go. Leaving them in the blob
      // would invite something to start reading them again.
      allowHumanHandoff: bool(r.allowHumanHandoff, base.routing.allowHumanHandoff),
      allowReturnToAi: bool(r.allowReturnToAi, base.routing.allowReturnToAi),
    },
    commerce: {
      productMessagingEnabled: bool(
        c.productMessagingEnabled,
        base.commerce.productMessagingEnabled,
      ),
      carouselSize: clampInt(c.carouselSize, 1, MAX_CAROUSEL_ITEMS, base.commerce.carouselSize),
      addToCartEnabled: bool(c.addToCartEnabled, base.commerce.addToCartEnabled),
      allowUnpublishedProducts: bool(
        c.allowUnpublishedProducts,
        base.commerce.allowUnpublishedProducts,
      ),
    },
    privacy: {
      useCartContext: bool(p.useCartContext, base.privacy.useCartContext),
      requireOfflineConsent: bool(p.requireOfflineConsent, base.privacy.requireOfflineConsent),
    },
    install: {
      storefrontDomains: domains,
      lastHeartbeatAt:
        typeof i.lastHeartbeatAt === "string" ? i.lastHeartbeatAt : base.install.lastHeartbeatAt,
      lastThemeId:
        typeof i.lastThemeId === "string"
          ? sanitizeToken(i.lastThemeId, 40) || null
          : base.install.lastThemeId,
      lastSeenPath:
        typeof i.lastSeenPath === "string"
          ? sanitizeToken(i.lastSeenPath, 200) || null
          : base.install.lastSeenPath,
    },
  };
}

/** Read the stored channel config off a ChannelAccount.platformMeta blob. */
export function readShopifyLiveChatConfig(platformMeta: unknown): ShopifyLiveChatConfig {
  const stored = (platformMeta && typeof platformMeta === "object"
    ? (platformMeta as Record<string, any>).shopifyLiveChat
    : null) as Record<string, any> | null;
  if (!stored) return defaultShopifyLiveChatConfig();
  const base = defaultShopifyLiveChatConfig();
  base.shopDomain = normalizeShopDomain(stored.shopDomain);
  base.tenantIntegrationId =
    typeof stored.tenantIntegrationId === "string" ? stored.tenantIntegrationId : null;
  return normalizeShopifyLiveChatConfig(stored, base);
}

// ─── Availability ────────────────────────────────────────────

export type Availability = "online" | "offline";

// resolveAvailability(hours) used to live here and evaluated the channel's
// own week/timezone. Availability is now answered from the TENANT's
// business hours (lib/business-hours.ts) - one schedule for the whole
// business, evaluated in one place, so the widget can never disagree with
// the AI employee about whether the store is open.


// ─── Visitor sessions ────────────────────────────────────────

export interface VisitorSessionPayload {
  /** Version marker so the format can change without accepting old shapes. */
  v: 1;
  tenantId: string;
  channelAccountId: string;
  /** Stable per-browser id - the Conversation.customerExternalId when anonymous. */
  visitorId: string;
  /**
   * Shopify's customer id, present ONLY when Shopify itself vouched for it
   * through the App Proxy. Never taken from anything the browser says.
   */
  customerId?: string | null;
  shopDomain: string;
  /** Issued at / expires at, epoch seconds. */
  iat: number;
  exp: number;
}

/**
 * Session key.
 *
 * Deliberately NOT the channel-credential key (CHANNEL_ENCRYPTION_KEY):
 * visitor sessions and stored Shopify credentials have completely
 * different rotation lifetimes, and reusing one key for both is the kind
 * of coupling that makes rotating either of them a migration.
 */
function sessionKey(): Buffer {
  const explicit = process.env.WIDGET_SESSION_SECRET;
  if (explicit && explicit.length >= 16) return derive(explicit);
  const jwtSecret = process.env.JWT_SECRET;
  if (jwtSecret && jwtSecret.length >= 16) return derive(`slc:${jwtSecret}`);
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "[shopify-live-chat] WIDGET_SESSION_SECRET (or JWT_SECRET) is required in production. " +
        "Refusing to issue visitor sessions with a default secret.",
    );
  }
  return derive("slc:dev-visitor-secret");
}

function derive(secret: string): Buffer {
  return crypto.createHash("sha256").update(`shopify-live-chat:visitor:${secret}`).digest();
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Genuinely opaque visitor session token: AES-256-GCM over the payload,
 * `iv || tag || ciphertext`, base64url.
 *
 * Encrypted rather than merely signed, because a signed-but-readable
 * token would hand every shopper our internal tenant and channel ids in
 * exchange for a base64 decode. GCM is authenticated, so this is also
 * tamper-evident without a second HMAC.
 *
 * Deliberately NOT a JWT and not even JWT-shaped: no middleware anywhere
 * in the platform should be able to mistake one of these for a staff
 * token, and it carries no user identity at all.
 */
export function signVisitorSession(
  input: Omit<VisitorSessionPayload, "v" | "iat" | "exp"> & { ttlSeconds?: number },
): string {
  const iat = Math.floor(Date.now() / 1000);
  const payload: VisitorSessionPayload = {
    v: 1,
    tenantId: input.tenantId,
    channelAccountId: input.channelAccountId,
    visitorId: input.visitorId,
    customerId: input.customerId ?? null,
    shopDomain: input.shopDomain,
    iat,
    exp: iat + (input.ttlSeconds ?? VISITOR_SESSION_TTL_SECONDS),
  };
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", sessionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return b64url(Buffer.concat([iv, cipher.getAuthTag(), ciphertext]));
}

/** Decrypt + validate. Returns null on any tampering, expiry or malformation. */
export function verifyVisitorSession(token: unknown): VisitorSessionPayload | null {
  if (typeof token !== "string" || !token || token.length > 4096) return null;

  let plaintext: string;
  try {
    const raw = fromB64url(token);
    if (raw.length <= IV_BYTES + TAG_BYTES) return null;
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      sessionKey(),
      raw.subarray(0, IV_BYTES),
    );
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    plaintext = Buffer.concat([
      decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Wrong key, flipped bit, truncated token, junk: all the same answer.
    return null;
  }

  let payload: VisitorSessionPayload;
  try {
    payload = JSON.parse(plaintext);
  } catch {
    return null;
  }
  if (payload?.v !== 1) return null;
  if (!payload.tenantId || !payload.channelAccountId || !payload.visitorId) return null;
  if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) return null;
  return payload;
}

/** Fresh opaque visitor id. The browser persists this; the server signs it. */
export function newVisitorId(): string {
  return `sfyv_${crypto.randomBytes(16).toString("hex")}`;
}

// ─── Storefront page context ─────────────────────────────────

export type StorefrontPageType =
  | "product"
  | "collection"
  | "cart"
  | "search"
  | "index"
  | "page"
  | "blog"
  | "other";

const PAGE_TYPES: StorefrontPageType[] = [
  "product", "collection", "cart", "search", "index", "page", "blog", "other",
];

const HANDLE_RE = /^[a-z0-9][a-z0-9-_]{0,120}$/;

export interface StorefrontContext {
  pageType: StorefrontPageType;
  /** Product handle when on a product page - the only product hint we keep. */
  productHandle: string | null;
  collectionHandle: string | null;
  /** Path only. Query strings routinely carry PII and marketing ids. */
  path: string | null;
  /** Item count only. Never contents, never value. */
  cartItemCount: number | null;
  currency: string | null;
  locale: string | null;
}

/**
 * Normalize the untrusted context blob the storefront bridge sends.
 *
 * Everything price-, stock- or identity-shaped is dropped on the floor:
 * the handle is a *lookup key* we re-resolve against Shopify server-side,
 * not a fact we repeat back.
 */
export function normalizeStorefrontContext(raw: unknown): StorefrontContext {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const handle = typeof src.productHandle === "string" ? src.productHandle.trim().toLowerCase() : "";
  const collection =
    typeof src.collectionHandle === "string" ? src.collectionHandle.trim().toLowerCase() : "";

  let path: string | null = null;
  if (typeof src.path === "string" && src.path.startsWith("/")) {
    path = sanitizeToken(src.path.split("?")[0], 200) || null;
  } else if (typeof src.pageUrl === "string") {
    try {
      path = sanitizeToken(new URL(src.pageUrl).pathname, 200) || null;
    } catch {
      path = null;
    }
  }

  const count = Number(src.cartItemCount);
  const currency = typeof src.currency === "string" ? src.currency.trim().toUpperCase() : "";
  const locale = typeof src.locale === "string" ? src.locale.trim() : "";

  return {
    pageType: PAGE_TYPES.includes(src.pageType) ? src.pageType : "other",
    productHandle: HANDLE_RE.test(handle) ? handle : null,
    collectionHandle: HANDLE_RE.test(collection) ? collection : null,
    path,
    cartItemCount: Number.isFinite(count) && count >= 0 && count < 10000 ? Math.floor(count) : null,
    currency: /^[A-Z]{3}$/.test(currency) ? currency : null,
    locale: /^[a-zA-Z]{2}(-[a-zA-Z]{2})?$/.test(locale) ? locale : null,
  };
}

// ─── Product snapshots ───────────────────────────────────────

export interface ProductVariantSnapshot {
  variantId: string;
  title: string;
  price: string | null;
  compareAtPrice: string | null;
  available: boolean;
  sku: string | null;
  /** Selected option values, e.g. ["Blue", "M"]. */
  options: string[];
  requiresSellingPlan: boolean;
}

export interface ProductSnapshot {
  /** Which store this product came from. Cross-store render is refused. */
  shopDomain: string;
  productId: string;
  handle: string;
  title: string;
  imageUrl: string | null;
  productUrl: string;
  currency: string;
  /** Price of the selected (or cheapest available) variant. */
  price: string | null;
  compareAtPrice: string | null;
  available: boolean;
  status: "active" | "draft" | "archived";
  vendor: string | null;
  /** Present when the AI/agent picked a specific variant. */
  selectedVariantId: string | null;
  /** Variant options the customer still has to choose. */
  optionNames: string[];
  variants: ProductVariantSnapshot[];
  /** Optional short "why this one" line from the AI employee. */
  reason: string | null;
  /** When the snapshot was taken - the card shows prices as of this time. */
  capturedAt: string;
}

/** Image hosts we will render. Shopify CDN only - no merchant-supplied hosts. */
const ALLOWED_IMAGE_HOSTS = [
  "cdn.shopify.com",
  "cdn.shopifycdn.net",
  "shopify-assets.shopifycdn.com",
];

/**
 * Product imagery is rendered inside the merchant's own storefront, so an
 * attacker-controlled image URL is a tracking pixel with a view of every
 * chat. Only Shopify's CDN is allowed through.
 */
export function sanitizeProductImageUrl(raw: unknown): string | null {
  const url = sanitizeAssetUrl(raw);
  if (!url) return null;
  try {
    const host = new URL(url).hostname.toLowerCase();
    const ok = ALLOWED_IMAGE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
    return ok ? url : null;
  } catch {
    return null;
  }
}

/** Canonical storefront product URL. Built by us, never taken from input. */
export function buildProductUrl(shopDomain: string, handle: string, variantId?: string | null): string {
  const base = `https://${shopDomain}/products/${encodeURIComponent(handle)}`;
  return variantId ? `${base}?variant=${encodeURIComponent(variantId)}` : base;
}

function money(raw: unknown): string | null {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n.toFixed(2);
}

export interface BuildProductSnapshotInput {
  shopDomain: string;
  currency: string;
  /** Raw Shopify REST Admin product object. */
  product: Record<string, any>;
  selectedVariantId?: string | null;
  reason?: string | null;
  now?: Date;
}

/**
 * Turn a raw Shopify product into the safe, chat-sized snapshot we
 * persist on a message. Trims Shopify's ~40-field payload to what a card
 * renders plus what a later Add to Cart needs to re-validate.
 */
export function buildProductSnapshot(input: BuildProductSnapshotInput): ProductSnapshot | null {
  const p = input.product;
  if (!p || typeof p !== "object") return null;
  const productId = p.id != null ? String(p.id) : "";
  const handleRaw = typeof p.handle === "string" ? p.handle.trim().toLowerCase() : "";
  if (!productId || !HANDLE_RE.test(handleRaw)) return null;

  const rawVariants: any[] = Array.isArray(p.variants) ? p.variants : [];
  const variants: ProductVariantSnapshot[] = rawVariants.slice(0, 100).map((v) => {
    // Prefer Shopify's own verdict when the source provided one (GraphQL
    // `availableForSale`). Only fall back to deriving it from the REST
    // inventory triplet, which is the lossier signal.
    const inventoryManaged = v?.inventory_management != null && v.inventory_management !== "";
    const policyContinues = String(v?.inventory_policy ?? "").toLowerCase() === "continue";
    const qty = Number(v?.inventory_quantity);
    const available =
      typeof v?.available === "boolean"
        ? v.available
        : !inventoryManaged || policyContinues || (Number.isFinite(qty) && qty > 0);
    return {
      variantId: v?.id != null ? String(v.id) : "",
      title: sanitizeToken(v?.title, 60) || "Default",
      price: money(v?.price),
      compareAtPrice: money(v?.compare_at_price),
      available,
      sku: sanitizeToken(v?.sku, 60) || null,
      options: [v?.option1, v?.option2, v?.option3]
        .filter((o) => typeof o === "string" && o.trim())
        .map((o) => sanitizeToken(o, 40)),
      requiresSellingPlan: v?.requires_selling_plan === true,
    };
  }).filter((v) => v.variantId);

  const selectedVariantId =
    input.selectedVariantId && variants.some((v) => v.variantId === String(input.selectedVariantId))
      ? String(input.selectedVariantId)
      : null;

  const priceSource =
    variants.find((v) => v.variantId === selectedVariantId) ??
    variants.find((v) => v.available) ??
    variants[0] ??
    null;

  const statusRaw = typeof p.status === "string" ? p.status.toLowerCase() : "active";
  const status: ProductSnapshot["status"] =
    statusRaw === "draft" || statusRaw === "archived" ? statusRaw : "active";

  const image =
    sanitizeProductImageUrl(p?.image?.src) ??
    sanitizeProductImageUrl(Array.isArray(p?.images) ? p.images[0]?.src : null);

  const optionNames = Array.isArray(p?.options)
    ? p.options
        .map((o: any) => sanitizeToken(o?.name, 40))
        .filter((n: string) => n && n.toLowerCase() !== "title")
    : [];

  return {
    shopDomain: input.shopDomain,
    productId,
    handle: handleRaw,
    title: sanitizeToken(p.title, 140) || handleRaw,
    imageUrl: image,
    productUrl: buildProductUrl(input.shopDomain, handleRaw, selectedVariantId),
    currency: /^[A-Z]{3}$/.test(input.currency) ? input.currency : "USD",
    price: priceSource?.price ?? null,
    compareAtPrice: priceSource?.compareAtPrice ?? null,
    available: variants.some((v) => v.available),
    status,
    vendor: sanitizeToken(p.vendor, 60) || null,
    selectedVariantId,
    optionNames,
    variants,
    reason: input.reason ? sanitizeToken(input.reason, 200) : null,
    capturedAt: (input.now ?? new Date()).toISOString(),
  };
}

/**
 * Payload stored in Message.metadata for a commerce message.
 * `channelAccountId` pins the message to the channel that produced it, so
 * a snapshot can never be rendered in another tenant's conversation even
 * if a row were somehow mis-joined.
 */
export interface ShopifyCommerceMessagePayload {
  kind: "shopify_commerce";
  shopDomain: string;
  channelAccountId: string;
  products: ProductSnapshot[];
  /** Whether the widget should offer Add to Cart for this message. */
  addToCartEnabled: boolean;
  source: "ai" | "agent";
}

// ─── Visitor-facing message projection ───────────────────────

export interface VisitorMessageView {
  id: string;
  direction: "INBOUND" | "OUTBOUND";
  body: string;
  messageType: string;
  /** Display name only - never a staff email address. */
  author: string | null;
  authorKind: "visitor" | "agent" | "ai";
  /**
   * The message's OWN language, when something upstream actually knows it
   * (a generated reply that was told which language to write in, a
   * translated message). Absent means "nobody stated one" - the widget
   * then detects the dominant script of the body and only falls back to
   * the conversation/store locale after that. See lib/text-direction.
   *
   * Deliberately not defaulted to the conversation locale here: a default
   * would be indistinguishable from a statement, and would override the
   * per-message script detection that makes an English agent reply inside
   * a Hebrew conversation render correctly.
   */
  locale?: string;
  createdAt: string;
  commerce: {
    addToCartEnabled: boolean;
    products: Array<Record<string, unknown>>;
  } | null;
}

export interface VisitorProjectionContext {
  assistantName: string;
  shopDomain: string;
  channelAccountId: string;
}

/**
 * The ONE place a stored message becomes something a shopper may see.
 *
 * Used by both the polling endpoint and the realtime socket projection,
 * so the two can never drift into disagreeing about what is safe to
 * expose. Internal fields - tenant id, tool logs, approval state, the
 * agent's email - stop here.
 *
 * Returns null for anything the shopper should not receive at all
 * (system breadcrumbs, empty rows, a commerce payload from another
 * store).
 */
export function projectVisitorMessage(
  message: {
    id: string;
    direction: string;
    body: string | null;
    messageType: string | null;
    senderName: string | null;
    metadata: unknown;
    mediaUrl?: string | null;
    createdAt: Date | string;
  },
  ctx: VisitorProjectionContext,
): VisitorMessageView | null {
  const messageType = message.messageType ?? "text";
  // Escalation breadcrumbs are inbox furniture, not chat content.
  if (messageType === "system") return null;

  const meta = (message.metadata ?? {}) as Record<string, any>;
  const commerce = projectCommerceForVisitor(meta, ctx);
  const body = message.body ?? "";
  if (!body && !message.mediaUrl && !commerce) return null;

  const direction = message.direction === "INBOUND" ? "INBOUND" : "OUTBOUND";
  const isAgent = direction === "OUTBOUND" && meta.source !== "ai_bot";

  // Only a well-formed language tag survives. A junk value would be worse
  // than none: it is the highest-priority rung of the direction chain, so
  // it would silently beat the script the message is actually written in.
  const declaredLocale =
    typeof meta.locale === "string" && /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(meta.locale.trim())
      ? meta.locale.trim()
      : undefined;

  return {
    id: message.id,
    direction,
    body,
    messageType,
    ...(declaredLocale ? { locale: declaredLocale } : {}),
    author:
      direction === "INBOUND"
        ? null
        : isAgent
          ? displayAgentName(message.senderName)
          : ctx.assistantName,
    authorKind: direction === "INBOUND" ? "visitor" : isAgent ? "agent" : "ai",
    createdAt:
      typeof message.createdAt === "string" ? message.createdAt : message.createdAt.toISOString(),
    commerce,
  };
}

/**
 * Staff identities arrive from the inbox composer as email addresses.
 * A shopper gets a first name, never a way to contact an agent directly.
 */
function displayAgentName(senderName: string | null): string {
  if (!senderName) return "Support";
  const local = senderName.includes("@") ? senderName.split("@")[0] : senderName;
  return sanitizeToken(local.replace(/[._-]+/g, " "), 40) || "Support";
}

function projectCommerceForVisitor(
  meta: Record<string, any>,
  ctx: VisitorProjectionContext,
): VisitorMessageView["commerce"] {
  const payload = meta?.shopify;
  if (!isRenderableCommercePayload(payload, {
    shopDomain: ctx.shopDomain,
    channelAccountId: ctx.channelAccountId,
  })) {
    return null;
  }
  return {
    addToCartEnabled: payload.addToCartEnabled === true,
    products: payload.products.map((p) => ({
      productId: p.productId,
      handle: p.handle,
      title: p.title,
      imageUrl: p.imageUrl,
      productUrl: p.productUrl,
      currency: p.currency,
      price: p.price,
      compareAtPrice: p.compareAtPrice,
      available: p.available,
      published: p.status === "active",
      selectedVariantId: p.selectedVariantId,
      optionNames: p.optionNames,
      reason: p.reason,
      variants: (p.variants ?? []).map((v) => ({
        variantId: v.variantId,
        title: v.title,
        price: v.price,
        compareAtPrice: v.compareAtPrice,
        available: v.available,
        options: v.options,
        requiresSellingPlan: v.requiresSellingPlan,
      })),
    })),
  };
}

/**
 * Guard used at RENDER time (widget payload + inbox). Rejects a payload
 * whose store or channel does not match the conversation it is being
 * rendered into. Cheap, and the last line of defence behind the query
 * scoping that should already have made it impossible.
 */
export function isRenderableCommercePayload(
  payload: unknown,
  expected: { shopDomain: string; channelAccountId: string },
): payload is ShopifyCommerceMessagePayload {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as ShopifyCommerceMessagePayload;
  if (p.kind !== "shopify_commerce") return false;
  if (p.shopDomain !== expected.shopDomain) return false;
  if (p.channelAccountId !== expected.channelAccountId) return false;
  if (!Array.isArray(p.products) || p.products.length === 0) return false;
  return p.products.every((prod) => prod && prod.shopDomain === expected.shopDomain);
}

// ─── Shopify → canonical recommendation ──────────────────────

/**
 * Turn validated Shopify snapshots into the channel-neutral
 * recommendation set.
 *
 * This is the ONLY place Shopify shape becomes recommendation shape. The
 * Shopify tools produce snapshots; the channel renderers consume
 * recommendations; neither knows about the other, so a second commerce
 * integration needs one function like this one and nothing else.
 *
 * Every field is carried across, never recomputed. The snapshot's price
 * already came from Shopify and survived `buildProductSnapshot`; running
 * it through a formatter here would be the third chance to get a number
 * wrong, for no gain.
 */
export function recommendationSetFromShopifySnapshots(input: {
  products: ProductSnapshot[];
  shopDomain: string;
  introduction?: string | null;
  /** Merchant switch. Add to Cart is never offered when it is off. */
  addToCartEnabled?: boolean;
}): ProductRecommendationSet {
  const products: RecommendedProduct[] = [];

  for (const snapshot of input.products) {
    // A snapshot from another store is refused rather than rendered. The
    // same rule the message writer applies, applied again at the boundary
    // a set crosses into channels that have no notion of a store.
    if (snapshot.shopDomain !== input.shopDomain) continue;

    const selected = snapshot.selectedVariantId
      ? snapshot.variants.find((v) => v.variantId === snapshot.selectedVariantId)
      : undefined;

    // Add to Cart requires a RESOLVED variant. A product whose options the
    // shopper still has to choose gets View Product only - picking a
    // variant for them is how somebody ends up with the wrong size.
    const purchasable =
      input.addToCartEnabled === true &&
      !!selected &&
      selected.available &&
      !selected.requiresSellingPlan &&
      snapshot.status === "active";

    products.push({
      productId: snapshot.productId,
      variantId: snapshot.selectedVariantId ?? undefined,
      title: snapshot.title,
      imageUrl: snapshot.imageUrl ?? undefined,
      productUrl: snapshot.productUrl,
      price: moneyFromSnapshot(selected?.price ?? snapshot.price, snapshot.currency),
      compareAtPrice: moneyFromSnapshot(
        selected?.compareAtPrice ?? snapshot.compareAtPrice,
        snapshot.currency,
      ),
      availability: (selected ? selected.available : snapshot.available)
        ? "in_stock"
        : "out_of_stock",
      reason: snapshot.reason ?? undefined,
      sku: selected?.sku ?? undefined,
      purchasable,
    });
  }

  return normalizeRecommendationSet({
    introduction: input.introduction ?? undefined,
    products,
    source: { integration: "shopify", shopDomain: input.shopDomain },
  });
}

function moneyFromSnapshot(
  amount: string | null | undefined,
  currency: string,
): RecommendationMoney | undefined {
  if (!amount) return undefined;
  return { amount, currency };
}

/**
 * The same snapshots as a set of provider records, for
 * `reconcileWithProvider`. Used when a set has travelled - staged on a
 * reply, queued for a retry - and has to be re-checked against what
 * Shopify says now before it reaches anyone.
 */
export function providerRecordsFromShopifySnapshots(
  snapshots: ProductSnapshot[],
): ProviderProductRecord[] {
  return snapshots.map((snapshot) => {
    const selected = snapshot.selectedVariantId
      ? snapshot.variants.find((v) => v.variantId === snapshot.selectedVariantId)
      : undefined;
    return {
      productId: snapshot.productId,
      variantId: snapshot.selectedVariantId ?? undefined,
      productUrl: snapshot.productUrl,
      title: snapshot.title,
      price: moneyFromSnapshot(selected?.price ?? snapshot.price, snapshot.currency),
      compareAtPrice: moneyFromSnapshot(
        selected?.compareAtPrice ?? snapshot.compareAtPrice,
        snapshot.currency,
      ),
      availability: (selected ? selected.available : snapshot.available)
        ? ("in_stock" as const)
        : ("out_of_stock" as const),
      imageUrl: snapshot.imageUrl ?? undefined,
      sku: selected?.sku ?? undefined,
      purchasable:
        !!selected && selected.available && !selected.requiresSellingPlan && snapshot.status === "active",
    };
  });
}
