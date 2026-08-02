/**
 * Shopify Live Chat — channel service.
 *
 * Owns the ChannelAccount lifecycle for SHOPIFY_LIVE_CHAT and the two
 * questions every other module asks:
 *
 *   1. "Is this public channel key servable right now?"  → resolveForBootstrap
 *   2. "What is the merchant's configuration?"           → loadChannel
 *
 * The bootstrap resolution is the security boundary for the public
 * storefront surface, so it is written as one function with an explicit
 * ordered set of checks and a single opaque failure shape. A storefront
 * never learns *why* it was refused — "unavailable" covers a disabled
 * channel, a lapsed entitlement and a disconnected store alike.
 */

import {
  prisma,
  withCrossTenantAccess,
  isFeatureEnabledForTenant,
  FEATURES,
  readShopifyLiveChatConfig,
  normalizeShopifyLiveChatConfig,
  buildAllowedOrigins,
  isOriginAllowed,
  normalizeShopDomain,
  getRedis,
  BUSINESS_HOURS_KEY,
  parseBusinessHours,
  evaluateBusinessHours,
  type ShopifyLiveChatConfig,
  type Availability, readDurableSetting } from "@chatcenter/shared";
// Read-only question asked of the CORE integration: "is a store connected?".
// The chat service never writes to it and never uses its token.
import { loadConnection } from "./connectors/integration-framework";

export const SHOPIFY_LIVE_CHAT = "SHOPIFY_LIVE_CHAT";

export interface ShopifyLiveChatChannel {
  id: string;
  tenantId: string;
  /** Public channel key — the only identifier the storefront ever sees. */
  publicKey: string;
  displayName: string;
  connectionStatus: string;
  config: ShopifyLiveChatConfig;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Loading ─────────────────────────────────────────────────

function toChannel(row: any): ShopifyLiveChatChannel {
  return {
    id: row.id,
    tenantId: row.tenantId,
    publicKey: row.externalId,
    displayName: row.displayName,
    connectionStatus: row.connectionStatus,
    config: readShopifyLiveChatConfig(row.platformMeta),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listChannels(tenantId: string): Promise<ShopifyLiveChatChannel[]> {
  const rows = await prisma.channelAccount.findMany({
    where: { tenantId, channel: SHOPIFY_LIVE_CHAT as any },
    orderBy: { createdAt: "asc" },
  });
  return rows.map(toChannel);
}

export async function loadChannel(
  tenantId: string,
  channelId: string,
): Promise<ShopifyLiveChatChannel | null> {
  const row = await prisma.channelAccount.findFirst({
    where: { id: channelId, tenantId, channel: SHOPIFY_LIVE_CHAT as any },
  });
  return row ? toChannel(row) : null;
}

// ─── Persisting config ───────────────────────────────────────

/**
 * Writes go through the normalizer, so the stored blob is always already
 * safe for every reader. `shopDomain` / `tenantIntegrationId` are carried
 * from the existing row and are not patchable — rebinding a channel to a
 * different store would orphan every product snapshot already sent.
 */
export async function saveChannelConfig(
  channel: ShopifyLiveChatChannel,
  patch: unknown,
): Promise<ShopifyLiveChatChannel> {
  const next = normalizeShopifyLiveChatConfig(patch, channel.config);
  const row = await prisma.channelAccount.update({
    where: { id: channel.id },
    data: {
      platformMeta: { shopifyLiveChat: next } as any,
      // The account is "CONNECTED" whenever the merchant wants the widget
      // live; disabling it flips the account too so every generic channel
      // listing (Settings → Channels, inbox badges) agrees.
      connectionStatus: next.enabled ? "CONNECTED" : "DISCONNECTED",
      isActive: next.enabled,
    },
  });
  return toChannel(row);
}

export async function recordHeartbeat(
  channelId: string,
  config: ShopifyLiveChatConfig,
  seen: { themeId?: string | null; path?: string | null },
): Promise<void> {
  const next: ShopifyLiveChatConfig = {
    ...config,
    install: {
      ...config.install,
      lastHeartbeatAt: new Date().toISOString(),
      lastThemeId: seen.themeId ?? config.install.lastThemeId,
      lastSeenPath: seen.path ?? config.install.lastSeenPath,
    },
  };
  await prisma.channelAccount.update({
    where: { id: channelId },
    data: {
      platformMeta: { shopifyLiveChat: next } as any,
      lastHealthCheck: new Date(),
    },
  });
}

// ─── Public bootstrap resolution ─────────────────────────────

export type BootstrapDenial =
  | "unknown_channel"
  | "disabled"
  | "origin_not_allowed"
  | "store_disconnected"
  | "not_entitled"
  | "tenant_inactive";

export type BootstrapResolution =
  | {
      ok: true;
      channel: ShopifyLiveChatChannel;
      availability: Availability;
      allowedOrigins: string[];
      /**
       * Product messaging survived the entitlement, the merchant's own
       * switch AND a live Core store connection. All three, because a
       * `true` here puts Add to Cart buttons in front of shoppers.
       */
      productMessagingEnabled: boolean;
      /** Core Shopify Integration reachable for this shop. */
      coreConnected: boolean;
    }
  | { ok: false; denial: BootstrapDenial };

/**
 * Resolve a storefront request into a servable channel.
 *
 * Two ways in, one trust model:
 *
 *   - `shopDomain` — the App Store path. The Theme App Embed publishes
 *     `shop.permanent_domain`, we look up the verified Chat installation
 *     for that shop and follow it to the channel. The merchant never sees
 *     or copies an identifier.
 *   - `publicKey` — the original manual path, kept as a recovery fallback
 *     for a merchant whose installation record is missing.
 *
 * Neither is proof of anything on its own: both are LOOKUP KEYS supplied by
 * a browser. The security is the Origin check below — a forged shop domain
 * from another site cannot present an origin that belongs to that shop.
 *
 * Order matters: cheap identity checks first, then the origin check (so a
 * forged shop domain is refused before we spend a DB read on features),
 * then entitlement. Every failure returns the same opaque body to the
 * caller — the discrimination here exists for our logs, not for the
 * storefront.
 */
/**
 * Is the business open right now?
 *
 * Read from the TENANT's business hours — the same configuration the AI
 * employee, the incoming worker and the settings page use. The channel
 * used to carry its own week/timezone, which meant a merchant kept two
 * schedules and only found out they disagreed when a shopper was told the
 * store was closed while everyone else thought it open.
 *
 * A store has one set of opening hours. Where a shopper happens to be
 * chatting from is not one of its inputs.
 */
async function resolveTenantAvailability(tenantId: string): Promise<Availability> {
  try {
    const cfg = parseBusinessHours(await readDurableSetting(tenantId, "businessHours"));
    return evaluateBusinessHours(cfg).open ? "online" : "offline";
  } catch (err: any) {
    // Config store unreachable → answer as open, matching what the AI
    // employee does. A widget that says "we are closed" because Redis
    // blinked is worse than one that answers out of hours.
    console.warn("[shopify-chat] business-hours read failed (treating as open):", err?.message);
    return "online";
  }
}

export async function resolveForBootstrap(input: {
  publicKey?: unknown;
  shopDomain?: unknown;
  origin: unknown;
}): Promise<BootstrapResolution> {
  const publicKey = typeof input.publicKey === "string" ? input.publicKey.trim() : "";
  const shopDomain = normalizeShopDomain(input.shopDomain);
  if (!publicKey && !shopDomain) return { ok: false, denial: "unknown_channel" };
  if (publicKey && publicKey.length > 128) return { ok: false, denial: "unknown_channel" };

  // The caller is anonymous and has no tenant context, so both lookups MUST
  // be cross-tenant. Everything downstream is scoped to the tenant we derive
  // from the row we found.
  let row: any = null;
  let installationDomains: string[] = [];

  if (shopDomain) {
    const installation = await withCrossTenantAccess(async () =>
      (prisma as any).shopifyChatInstallation.findFirst({
        where: { shopDomain, status: "ACTIVE" },
      }),
    );
    if (installation?.channelAccountId) {
      installationDomains = Array.isArray(installation.verifiedDomains)
        ? (installation.verifiedDomains as string[])
        : [];
      row = await withCrossTenantAccess(async () =>
        prisma.channelAccount.findFirst({
          where: { id: installation.channelAccountId, channel: SHOPIFY_LIVE_CHAT as any },
        }),
      );
    }
  }

  if (!row && publicKey) {
    row = await withCrossTenantAccess(async () =>
      prisma.channelAccount.findFirst({
        where: { externalId: publicKey, channel: SHOPIFY_LIVE_CHAT as any },
      }),
    );
  }
  if (!row) return { ok: false, denial: "unknown_channel" };

  const channel = toChannel(row);
  if (!channel.config.enabled || row.connectionStatus !== "CONNECTED") {
    return { ok: false, denial: "disabled" };
  }

  const channelShop = normalizeShopDomain(channel.config.shopDomain);
  if (!channelShop) return { ok: false, denial: "store_disconnected" };
  // A lookup by shop must land on a channel bound to THAT shop. Without
  // this, a stale installation row pointing at a re-bound channel could
  // serve one storefront's widget to another's shoppers.
  if (shopDomain && shopDomain !== channelShop) return { ok: false, denial: "unknown_channel" };

  const allowedOrigins = buildAllowedOrigins(channelShop, [
    ...channel.config.install.storefrontDomains,
    // Domains Shopify itself confirmed belong to this shop, recorded at
    // install time. The merchant never types these.
    ...installationDomains,
  ]);
  if (!isOriginAllowed(input.origin, allowedOrigins)) {
    return { ok: false, denial: "origin_not_allowed" };
  }

  const tenant = await withCrossTenantAccess(async () =>
    prisma.tenant.findUnique({ where: { id: channel.tenantId }, select: { status: true, isActive: true } }),
  );
  if (!tenant || !tenant.isActive || tenant.status !== "ACTIVE") {
    return { ok: false, denial: "tenant_inactive" };
  }

  const entitled = await isFeatureEnabledForTenant(channel.tenantId, FEATURES.SHOPIFY_LIVE_CHAT);
  if (!entitled) return { ok: false, denial: "not_entitled" };

  const productEntitled = await isFeatureEnabledForTenant(
    channel.tenantId,
    FEATURES.SHOPIFY_PRODUCT_MESSAGING,
  );

  // Product truth comes from the CORE Shopify Integration. Without it the
  // server will refuse every product card and cart validation, so promising
  // the capability here would make the widget offer buttons that fail. A
  // connection lookup, not an API call: this runs on every page load.
  let coreConnected = false;
  try {
    const conn = await loadConnection({ tenantId: channel.tenantId, slug: "shopify" });
    coreConnected = !!conn && normalizeShopDomain(conn.config?.shopDomain) === channelShop;
  } catch (err) {
    console.warn("[shopify-live-chat] core connection probe failed:", (err as Error)?.message);
  }

  return {
    ok: true,
    channel,
    availability: await resolveTenantAvailability(channel.tenantId),
    allowedOrigins,
    productMessagingEnabled:
      productEntitled && channel.config.commerce.productMessagingEnabled && coreConnected,
    coreConnected,
  };
}

/**
 * Same entitlement question, asked from an authenticated surface (agent
 * product picker, AI tool dispatch) where we already know the tenant.
 */
export async function isProductMessagingAllowed(
  tenantId: string,
  config: ShopifyLiveChatConfig,
): Promise<boolean> {
  if (!config.commerce.productMessagingEnabled) return false;
  return isFeatureEnabledForTenant(tenantId, FEATURES.SHOPIFY_PRODUCT_MESSAGING);
}

/** Find the live-chat channel a conversation belongs to, if any. */
export async function loadChannelForConversation(
  tenantId: string,
  conversationId: string,
): Promise<{ channel: ShopifyLiveChatChannel; conversation: any } | null> {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, tenantId, channel: SHOPIFY_LIVE_CHAT as any },
    include: { channelAccount: true },
  });
  if (!conversation?.channelAccount) return null;
  return { channel: toChannel(conversation.channelAccount), conversation };
}
