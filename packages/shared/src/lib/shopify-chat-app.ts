/**
 * GOTCHA Shopify Chat App — identity, verification and state.
 *
 * This module is the boundary between the two Shopify products. Everything
 * here belongs to the **Chat App**: its own client id, its own secret, its
 * own HMAC verification, its own installation lifecycle.
 *
 * It must never read SHOPIFY_API_KEY / SHOPIFY_API_SECRET. Those are the
 * **Core Shopify Integration's** credentials, and a single accidental reuse
 * would mean a chat uninstall could revoke a merchant's commerce connection
 * — the exact coupling the two-app split exists to prevent. The one-way
 * dependency is: Chat may READ a safe product projection that Core owns.
 * Nothing flows the other way.
 */

import crypto from "crypto";

// ─── App identity ────────────────────────────────────────────

export interface ShopifyChatAppConfig {
  clientId: string;
  clientSecret: string;
  /** Public base for the merchant-facing app (frontend origin). */
  appUrl: string;
  /** Absolute OAuth callback. Must match the Partner Dashboard exactly. */
  redirectUri: string;
  /** Theme App Extension handle (directory name). */
  extensionHandle: string;
  /** App Embed BLOCK handle — the .liquid file name, underscores and all. */
  blockHandle: string;
  /** App handle used in admin deep links. */
  appHandle: string;
}

/**
 * Read the Chat app configuration from the environment.
 *
 * Returns what is present rather than throwing: an unconfigured deployment
 * must be able to boot and say "not configured" on the one route that needs
 * it, instead of taking the whole AI service down.
 */
export function getShopifyChatAppConfig(): ShopifyChatAppConfig {
  return {
    clientId: process.env.SHOPIFY_CHAT_APP_CLIENT_ID || "",
    clientSecret: process.env.SHOPIFY_CHAT_APP_SECRET || "",
    appUrl: (process.env.SHOPIFY_CHAT_APP_URL || "").replace(/\/+$/, ""),
    redirectUri: process.env.SHOPIFY_CHAT_REDIRECT_URI || "",
    extensionHandle: process.env.SHOPIFY_CHAT_EXTENSION_HANDLE || "gotcha-chat",
    // The BLOCK handle is the liquid file name (`blocks/gotcha_chat.liquid`),
    // which is NOT the extension handle (`gotcha-chat`). Shopify's Theme
    // Editor deep link wants the block. Getting this wrong opens the editor
    // with nothing selected, which reads to a merchant as "the link is broken".
    blockHandle: process.env.SHOPIFY_CHAT_BLOCK_HANDLE || "gotcha_chat",
    appHandle: process.env.SHOPIFY_CHAT_APP_HANDLE || "gotcha-chat",
  };
}

export interface ChatAppConfigProblem {
  key: string;
  detail: string;
}

/** Everything missing that would make an install fail. Empty = ready. */
export function validateChatAppConfig(cfg = getShopifyChatAppConfig()): ChatAppConfigProblem[] {
  const problems: ChatAppConfigProblem[] = [];
  if (!cfg.clientId) problems.push({ key: "SHOPIFY_CHAT_APP_CLIENT_ID", detail: "Chat app client id is not set." });
  if (!cfg.clientSecret) problems.push({ key: "SHOPIFY_CHAT_APP_SECRET", detail: "Chat app secret is not set." });
  if (!cfg.appUrl) problems.push({ key: "SHOPIFY_CHAT_APP_URL", detail: "Chat app public URL is not set." });
  if (!cfg.redirectUri) problems.push({ key: "SHOPIFY_CHAT_REDIRECT_URI", detail: "Chat OAuth callback is not set." });

  // A Chat credential that equals a Core credential is not a configuration
  // slip, it is the failure this whole module exists to make impossible.
  if (cfg.clientId && process.env.SHOPIFY_API_KEY && cfg.clientId === process.env.SHOPIFY_API_KEY) {
    problems.push({
      key: "SHOPIFY_CHAT_APP_CLIENT_ID",
      detail: "Chat client id equals the Core app's SHOPIFY_API_KEY. They must be two different Partner apps.",
    });
  }
  if (cfg.clientSecret && process.env.SHOPIFY_API_SECRET && cfg.clientSecret === process.env.SHOPIFY_API_SECRET) {
    problems.push({
      key: "SHOPIFY_CHAT_APP_SECRET",
      detail: "Chat secret equals the Core app's SHOPIFY_API_SECRET. They must be two different Partner apps.",
    });
  }
  return problems;
}

export function isChatAppConfigured(cfg = getShopifyChatAppConfig()): boolean {
  return validateChatAppConfig(cfg).length === 0;
}

// ─── Shop domain ─────────────────────────────────────────────

const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/**
 * Normalize anything a merchant might type or Shopify might send into a
 * canonical `<shop>.myshopify.com`, or null.
 *
 * Deliberately strict about the suffix: `evil.com/?x=.myshopify.com` and
 * `myshopify.com.evil.com` are the two shapes that turn a shop parameter
 * into an open redirect or an SSRF target.
 */
export function normalizeShopifyShopDomain(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const raw = input.trim().toLowerCase();
  if (!raw || raw.length > 255) return null;
  const stripped = raw
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "");
  const candidate = stripped.endsWith(".myshopify.com") ? stripped : `${stripped}.myshopify.com`;
  if (!SHOP_DOMAIN_RE.test(candidate)) return null;
  // Reject the bare suffix and anything with an embedded dot in the slug.
  const slug = candidate.slice(0, -".myshopify.com".length);
  if (!slug || slug.includes(".")) return null;
  return candidate;
}

/** A storefront host the merchant may serve the widget from. */
export function normalizeStorefrontHost(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const raw = input.trim().toLowerCase();
  if (!raw || raw.length > 255) return null;
  const host = raw
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "");
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) return null;
  return host;
}

// ─── HMAC verification ───────────────────────────────────────

/** Constant-time compare that never throws on length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Verify the `hmac` on an OAuth callback / app entry request.
 *
 * Shopify signs the query string: every parameter except `hmac` and
 * `signature`, sorted by key, joined `k=v` with `&`, HMAC-SHA256 hex.
 */
export function verifyShopifyQueryHmac(
  query: Record<string, unknown>,
  secret: string,
): boolean {
  if (!secret) return false;
  const provided = typeof query.hmac === "string" ? query.hmac : "";
  if (!provided) return false;

  const message = Object.keys(query)
    .filter((k) => k !== "hmac" && k !== "signature")
    .sort()
    .map((k) => {
      const v = query[k];
      const value = Array.isArray(v) ? v.join(",") : String(v ?? "");
      return `${k}=${value}`;
    })
    .join("&");

  const digest = crypto.createHmac("sha256", secret).update(message, "utf8").digest("hex");
  return safeEqual(digest, provided.toLowerCase());
}

/**
 * Verify `X-Shopify-Hmac-Sha256` over the RAW request body.
 *
 * Raw body, not the parsed object: `JSON.stringify(req.body)` re-orders and
 * re-formats, so it verifies a different byte sequence than Shopify signed
 * and every legitimate webhook fails.
 */
export function verifyShopifyWebhookHmac(
  rawBody: Buffer | string | undefined,
  headerHmac: unknown,
  secret: string,
): boolean {
  if (!secret || rawBody == null) return false;
  const provided = typeof headerHmac === "string" ? headerHmac : "";
  if (!provided) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8");
  const digest = crypto.createHmac("sha256", secret).update(body).digest("base64");
  return safeEqual(digest, provided);
}

// ─── Theme Editor deep link ──────────────────────────────────

/**
 * Deep link that opens the merchant's live theme with our App Embed ready
 * to switch on.
 *
 * `activateAppId` takes `<app client id>/<block handle>`. Both halves have
 * bitten this codebase already: the client id was read from an env var that
 * was never set in any compose file, and the block handle defaulted to the
 * EXTENSION handle (`gotcha-chat`) rather than the block file name
 * (`gotcha_chat`).
 */
export function buildThemeEditorDeepLink(input: {
  shopDomain: string;
  clientId: string;
  blockHandle: string;
}): string | null {
  const shop = normalizeShopifyShopDomain(input.shopDomain);
  if (!shop || !input.clientId || !input.blockHandle) return null;
  const target = `${input.clientId}/${input.blockHandle}`;
  return `https://${shop}/admin/themes/current/editor?context=apps&activateAppId=${encodeURIComponent(target)}`;
}

/** Where a merchant manages the app inside Shopify admin. */
export function buildAppAdminLink(shopDomain: string, appHandle: string): string | null {
  const shop = normalizeShopifyShopDomain(shopDomain);
  if (!shop || !appHandle) return null;
  return `https://${shop}/admin/apps/${encodeURIComponent(appHandle)}`;
}

// ─── Activation state machine ────────────────────────────────

/**
 * One vocabulary for "is the chat actually live?", shared by the onboarding
 * wizard, the settings diagnostics and the storefront bootstrap.
 *
 * Ordered worst-first. The first condition that holds is the one the
 * merchant has to act on, so a caller can render exactly one next step
 * instead of a list of everything that is not perfect.
 */
export type ChatActivationState =
  | "APP_NOT_INSTALLED"
  | "INSTALLATION_UNBOUND"
  | "CHANNEL_NOT_CREATED"
  | "TENANT_INACTIVE"
  | "ENTITLEMENT_DISABLED"
  | "EMBED_NOT_ENABLED"
  | "EMBED_ENABLED_NOT_SEEN"
  | "STALE"
  | "UNINSTALLED"
  | "CORE_DISCONNECTED_PRODUCT_CHAT_UNAVAILABLE"
  | "LIVE";

export interface ChatActivationInput {
  installation: {
    status: "PENDING" | "ACTIVE" | "UNINSTALLED";
    tenantId: string | null;
    channelAccountId: string | null;
  } | null;
  channelExists: boolean;
  channelEnabled: boolean;
  tenantActive: boolean;
  chatEntitled: boolean;
  /** The merchant has switched the App Embed on (or we have never seen it). */
  lastHeartbeatAt: Date | null;
  /** Core Shopify connection present — only affects product messaging. */
  coreConnected: boolean;
  now?: Date;
}

/**
 * A storefront that is serving shoppers pings us on every page load, so
 * silence is meaningful within hours, not days. The previous seven-day
 * window meant a merchant could change theme on Monday and still be told
 * "activated" on Friday.
 */
export const HEARTBEAT_FRESH_MS = 24 * 60 * 60 * 1000;
/** Below this we have simply not seen it yet, rather than "it broke". */
export const HEARTBEAT_GRACE_MS = 10 * 60 * 1000;

export function resolveChatActivationState(input: ChatActivationInput): ChatActivationState {
  const now = input.now ?? new Date();
  const inst = input.installation;

  if (!inst) return "APP_NOT_INSTALLED";
  if (inst.status === "UNINSTALLED") return "UNINSTALLED";
  if (!inst.tenantId) return "INSTALLATION_UNBOUND";
  if (!input.channelExists || !inst.channelAccountId) return "CHANNEL_NOT_CREATED";
  if (!input.tenantActive) return "TENANT_INACTIVE";
  if (!input.chatEntitled) return "ENTITLEMENT_DISABLED";
  if (!input.channelEnabled) return "EMBED_NOT_ENABLED";

  // Never seen from a storefront: the merchant may have just saved the
  // theme and no shopper has loaded a page yet. That is not a failure, and
  // it is not "live" either.
  const hb = input.lastHeartbeatAt ? input.lastHeartbeatAt.getTime() : null;
  if (hb == null) return "EMBED_ENABLED_NOT_SEEN";
  if (now.getTime() - hb > HEARTBEAT_FRESH_MS) return "STALE";

  // Live, but say so honestly when the commerce half is missing: text chat
  // is working and product cards are not, and one word has to carry that.
  if (!input.coreConnected) return "CORE_DISCONNECTED_PRODUCT_CHAT_UNAVAILABLE";
  return "LIVE";
}

/** Is the widget allowed to serve shoppers in this state? */
export function isServingState(state: ChatActivationState): boolean {
  return (
    state === "LIVE" ||
    state === "STALE" ||
    state === "EMBED_ENABLED_NOT_SEEN" ||
    state === "CORE_DISCONNECTED_PRODUCT_CHAT_UNAVAILABLE"
  );
}
