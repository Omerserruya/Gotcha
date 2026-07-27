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
  resolveAvailability,
  normalizeShopDomain,
  type ShopifyLiveChatConfig,
  type Availability,
} from "@chatcenter/shared";

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
      /** Product messaging survived both the entitlement and the config. */
      productMessagingEnabled: boolean;
    }
  | { ok: false; denial: BootstrapDenial };

/**
 * Resolve a public channel key into a servable channel.
 *
 * Order matters: cheap identity checks first, then the origin check (so a
 * forged shop domain is refused before we spend a DB read on features),
 * then entitlement. Every failure returns the same opaque body to the
 * caller — the discrimination here exists for our logs, not for the
 * storefront.
 */
export async function resolveForBootstrap(input: {
  publicKey: unknown;
  origin: unknown;
}): Promise<BootstrapResolution> {
  const publicKey = typeof input.publicKey === "string" ? input.publicKey.trim() : "";
  if (!publicKey || publicKey.length > 128) return { ok: false, denial: "unknown_channel" };

  // The caller is anonymous and has no tenant context; the public key is
  // globally unique by construction, so this lookup MUST be cross-tenant.
  // Everything downstream is scoped to the tenant we derive from the row.
  const row = await withCrossTenantAccess(async () =>
    prisma.channelAccount.findFirst({
      where: { externalId: publicKey, channel: SHOPIFY_LIVE_CHAT as any },
    }),
  );
  if (!row) return { ok: false, denial: "unknown_channel" };

  const channel = toChannel(row);
  if (!channel.config.enabled || row.connectionStatus !== "CONNECTED") {
    return { ok: false, denial: "disabled" };
  }

  const shopDomain = normalizeShopDomain(channel.config.shopDomain);
  if (!shopDomain) return { ok: false, denial: "store_disconnected" };

  const allowedOrigins = buildAllowedOrigins(shopDomain, channel.config.install.storefrontDomains);
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

  return {
    ok: true,
    channel,
    availability: resolveAvailability(channel.config.hours),
    allowedOrigins,
    productMessagingEnabled: productEntitled && channel.config.commerce.productMessagingEnabled,
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
