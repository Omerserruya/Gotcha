/**
 * GOTCHA Shopify Chat App - installation lifecycle.
 *
 * Owns the `ShopifyChatInstallation` row from the moment Shopify
 * authorization completes until an `app/uninstalled` webhook retires it,
 * and the binding that turns a verified shop into a working channel.
 *
 * Boundary rules, enforced here rather than trusted to callers:
 *
 *   - Nothing in this file reads or writes `TenantIntegration`. That table
 *     belongs to the GOTCHA Core Shopify Integration; the only thing we ask
 *     Core is the read-only question "is a store connected, and what is its
 *     primary domain?".
 *   - A tenant id is never accepted from a browser as authority. Callers
 *     pass one only after `requirePermission` has proved the signed-in user
 *     may connect channels in it.
 *   - The `ShopifyChatInstallation` model is deliberately absent from the
 *     Prisma tenant guard: a row exists BEFORE any tenant is known. Every
 *     tenant-scoped read below therefore filters on tenantId explicitly.
 */

import crypto from "crypto";
import {
  prisma,
  withCrossTenantAccess,
  getRedis,
  encryptCredentials,
  defaultShopifyLiveChatConfig,
  normalizeShopifyLiveChatConfig,
  readShopifyLiveChatConfig,
  normalizeShopifyShopDomain,
  normalizeStorefrontHost,
  resolveChatActivationState,
  getShopifyAppIdentity,
  buildThemeEditorDeepLink,
  isFeatureEnabledForTenant,
  FEATURES,
  type ChatActivationState,
} from "@chatcenter/shared";
import { SHOPIFY_LIVE_CHAT, loadChannel, type ShopifyLiveChatChannel } from "./shopify-live-chat.service";
import { resolveShopifyStore } from "./shopify-catalog.service";
import { executeAdapterTool, loadConnection } from "./connectors/integration-framework";

export type InstallStatus = "PENDING" | "ACTIVE" | "UNINSTALLED";

export interface ChatInstallation {
  id: string;
  shopDomain: string;
  status: InstallStatus;
  tenantId: string | null;
  channelAccountId: string | null;
  verifiedDomains: string[];
  installedAt: Date;
  uninstalledAt: Date | null;
  boundAt: Date | null;
  lastHeartbeatAt: Date | null;
}

function toInstallation(row: any): ChatInstallation {
  return {
    id: row.id,
    shopDomain: row.shopDomain,
    status: row.status,
    tenantId: row.tenantId ?? null,
    channelAccountId: row.channelAccountId ?? null,
    verifiedDomains: Array.isArray(row.verifiedDomains) ? (row.verifiedDomains as string[]) : [],
    installedAt: row.installedAt,
    uninstalledAt: row.uninstalledAt ?? null,
    boundAt: row.boundAt ?? null,
    lastHeartbeatAt: row.lastHeartbeatAt ?? null,
  };
}

// ─── Lookup ──────────────────────────────────────────────────

/** The one installation that may currently serve this shop, if any. */
export async function findLiveInstallation(shopDomain: string): Promise<ChatInstallation | null> {
  const shop = normalizeShopifyShopDomain(shopDomain);
  if (!shop) return null;
  const row = await withCrossTenantAccess(async () =>
    (prisma as any).shopifyChatInstallation.findFirst({
      where: { shopDomain: shop, status: { not: "UNINSTALLED" } },
    }),
  );
  return row ? toInstallation(row) : null;
}

/** Including retired rows - used by reinstall and by audit surfaces. */
export async function findLatestInstallation(shopDomain: string): Promise<ChatInstallation | null> {
  const shop = normalizeShopifyShopDomain(shopDomain);
  if (!shop) return null;
  const row = await withCrossTenantAccess(async () =>
    (prisma as any).shopifyChatInstallation.findFirst({
      where: { shopDomain: shop },
      orderBy: [{ status: "asc" }, { installedAt: "desc" }],
    }),
  );
  return row ? toInstallation(row) : null;
}

export async function findInstallationById(id: string): Promise<ChatInstallation | null> {
  const row = await withCrossTenantAccess(async () =>
    (prisma as any).shopifyChatInstallation.findUnique({ where: { id } }),
  );
  return row ? toInstallation(row) : null;
}

// ─── Install / reinstall ─────────────────────────────────────

/**
 * Record a completed Shopify authorization.
 *
 * Idempotent by shop, and reinstall-aware: when a merchant removes the app
 * and installs it again, Shopify has just re-proved they control the same
 * store, so restoring the previous tenant/channel binding is safe and is
 * what a merchant expects ("it remembered my setup"). Restoring it BEFORE
 * that proof would be a takeover: anyone who could name the shop domain
 * would inherit its channel.
 */
export async function recordAuthorizedInstall(input: {
  shopDomain: string;
  accessToken?: string | null;
  scopes?: string | null;
}): Promise<ChatInstallation> {
  const shop = normalizeShopifyShopDomain(input.shopDomain);
  if (!shop) throw new Error("invalid_shop_domain");

  // Only store token material when the app actually has scopes. Version 1
  // requests none, so there is normally nothing here to protect.
  const encrypted = input.accessToken
    ? encryptCredentials({ accessToken: input.accessToken, scope: input.scopes ?? null })
    : null;

  return withCrossTenantAccess(async () => {
    const existing = await (prisma as any).shopifyChatInstallation.findFirst({
      where: { shopDomain: shop, status: { not: "UNINSTALLED" } },
    });

    if (existing) {
      const row = await (prisma as any).shopifyChatInstallation.update({
        where: { id: existing.id },
        data: {
          ...(encrypted ? { accessToken: encrypted, tokenScopes: input.scopes ?? null } : {}),
          lastVerifiedAt: new Date(),
          status: existing.tenantId && existing.channelAccountId ? "ACTIVE" : "PENDING",
        },
      });
      return toInstallation(row);
    }

    // Reinstall: revive the most recent retired row so the merchant keeps
    // their channel, conversations and configuration.
    const retired = await (prisma as any).shopifyChatInstallation.findFirst({
      where: { shopDomain: shop, status: "UNINSTALLED" },
      orderBy: { uninstalledAt: "desc" },
    });
    if (retired) {
      const row = await (prisma as any).shopifyChatInstallation.update({
        where: { id: retired.id },
        data: {
          status: retired.tenantId && retired.channelAccountId ? "ACTIVE" : "PENDING",
          uninstalledAt: null,
          installedAt: new Date(),
          lastVerifiedAt: new Date(),
          ...(encrypted ? { accessToken: encrypted, tokenScopes: input.scopes ?? null } : {}),
        },
      });
      return toInstallation(row);
    }

    const row = await (prisma as any).shopifyChatInstallation.create({
      data: {
        shopDomain: shop,
        status: "PENDING",
        // Which Shopify app this row came from. "gotcha-core" marks the
        // unified app; rows written before the cutover carry "gotcha-chat"
        // or "gotcha-chat-dev", which is exactly the provenance this column
        // exists to preserve.
        appIdentity: getShopifyAppIdentity().appHandle || "gotcha-core",
        ...(encrypted ? { accessToken: encrypted, tokenScopes: input.scopes ?? null } : {}),
        verifiedDomains: [shop],
        lastVerifiedAt: new Date(),
      },
    });
    return toInstallation(row);
  });
}

// ─── Continuation session ────────────────────────────────────
//
// Carries "this browser just completed a verified Shopify install" across
// a GOTCHA sign-in that may not exist yet. It is NOT authority to bind: it
// names an installation, and the signed-in user's memberships decide which
// organization may claim it.

const SESSION_TTL_SECONDS = 45 * 60;
const sessionKey = (token: string) => `shopify-chat:install-session:${token}`;

export async function createInstallSession(installationId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("base64url");
  await getRedis().set(
    sessionKey(token),
    JSON.stringify({ installationId, issuedAt: Date.now() }),
    "EX",
    SESSION_TTL_SECONDS,
  );
  return token;
}

export async function readInstallSession(token: unknown): Promise<{ installationId: string } | null> {
  if (typeof token !== "string" || !token || token.length > 200) return null;
  const raw = await getRedis().get(sessionKey(token));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed?.installationId === "string" ? { installationId: parsed.installationId } : null;
  } catch {
    return null;
  }
}

export async function discardInstallSession(token: unknown): Promise<void> {
  if (typeof token !== "string" || !token) return;
  await getRedis().del(sessionKey(token)).catch(() => undefined);
}

// ─── Verified storefront domains ─────────────────────────────

/**
 * Which origins may serve this shop's widget.
 *
 * The canonical `*.myshopify.com` comes from the install itself and is
 * therefore verified by construction. The merchant's real storefront is
 * usually a custom domain, and the only trustworthy source for it is
 * Shopify - so we ask the Core connection when there is one, and we never
 * accept a domain the storefront browser claims for itself.
 */
export async function refreshVerifiedDomains(installation: ChatInstallation): Promise<string[]> {
  const domains = new Set<string>([installation.shopDomain]);
  for (const d of installation.verifiedDomains) {
    const host = normalizeStorefrontHost(d);
    if (host) domains.add(host);
  }

  if (installation.tenantId) {
    try {
      const store = await resolveShopifyStore(installation.tenantId);
      if (store.ok && store.store.shopDomain === installation.shopDomain) {
        const r = await executeAdapterTool({
          tenantId: installation.tenantId,
          toolFunctionName: "shopify.get_shop",
          args: {},
        });
        if (r.ok) {
          const primary = normalizeStorefrontHost((r.result as any)?.primary_domain);
          if (primary) domains.add(primary);
        }
      }
    } catch (err) {
      // A domain we could not verify is simply not added. Never fatal:
      // the canonical domain always works, and the merchant can add one
      // by hand from the recovery screen.
      console.warn("[shopify-chat-install] domain probe failed:", (err as Error)?.message);
    }
  }

  const list = [...domains];
  await withCrossTenantAccess(async () =>
    (prisma as any).shopifyChatInstallation.update({
      where: { id: installation.id },
      data: { verifiedDomains: list, lastVerifiedAt: new Date() },
    }),
  );
  return list;
}

// ─── Origin recognition (CORS preflight only) ────────────────

/**
 * Is this Origin a storefront we have ever verified, for ANY tenant?
 *
 * Needed because a CORS preflight carries no body: at OPTIONS time we do
 * not yet know which shop the request is for, so the per-channel origin
 * check that guards the real request cannot run. This answers the weaker
 * question the preflight can actually ask - "is this origin one of our
 * merchants' storefronts at all?" - so an unrelated site is refused up
 * front instead of being told which methods it may use.
 *
 * This is NOT authorization. The real request still resolves the channel
 * and re-checks the origin against THAT channel's allowlist; a preflight
 * grants nothing on its own.
 */
const ORIGIN_CACHE_TTL_MS = 60_000;
const knownOriginCache = new Map<string, { ok: boolean; expiresAt: number }>();

/** Test-only: drop cached origin lookups. */
export function __resetKnownOriginCache(): void {
  knownOriginCache.clear();
}

export async function isKnownStorefrontOrigin(origin: unknown): Promise<boolean> {
  if (typeof origin !== "string" || !origin) return false;
  let host: string;
  try {
    const u = new URL(origin);
    // http:// storefronts do not exist on Shopify, and allowing one would
    // let a plaintext page speak for a merchant's domain.
    if (u.protocol !== "https:") return false;
    host = u.hostname.toLowerCase();
  } catch {
    return false;
  }

  const cached = knownOriginCache.get(host);
  if (cached && cached.expiresAt > Date.now()) return cached.ok;

  let ok = false;
  try {
    // Any live installation that verified this host.
    const install = await withCrossTenantAccess(async () =>
      (prisma as any).shopifyChatInstallation.findFirst({
        where: { status: "ACTIVE", verifiedDomains: { array_contains: host } },
        select: { id: true },
      }),
    );
    ok = !!install;

    if (!ok) {
      // Or a channel bound to this shop / carrying it as a storefront
      // domain - covers a channel created through the manual path.
      const rows = await withCrossTenantAccess(async () =>
        prisma.channelAccount.findMany({
          where: { channel: SHOPIFY_LIVE_CHAT as any, isActive: true },
          select: { platformMeta: true },
        }),
      );
      ok = rows.some((r: any) => {
        const cfg = r.platformMeta?.shopifyLiveChat;
        if (!cfg) return false;
        if (normalizeShopifyShopDomain(cfg.shopDomain) === host) return true;
        const extra: string[] = Array.isArray(cfg.install?.storefrontDomains)
          ? cfg.install.storefrontDomains
          : [];
        return extra.some((d) => normalizeStorefrontHost(d) === host);
      });
    }
  } catch (err) {
    // Fail CLOSED. A preflight we cannot evaluate is refused; the widget
    // retries, and no unknown site is handed an allowance because our
    // database blinked.
    console.warn("[shopify-chat] origin recognition failed:", (err as Error)?.message);
    ok = false;
  }

  knownOriginCache.set(host, { ok, expiresAt: Date.now() + ORIGIN_CACHE_TTL_MS });
  return ok;
}

// ─── Binding ─────────────────────────────────────────────────

export type BindFailure =
  | "installation_not_found"
  | "installation_uninstalled"
  | "bound_to_other_tenant"
  | "shop_taken"
  | "not_entitled";

export type BindResult =
  | { ok: true; installation: ChatInstallation; channel: ShopifyLiveChatChannel; created: boolean }
  | { ok: false; reason: BindFailure };

/**
 * Bind a verified installation to an organization and guarantee exactly one
 * Shopify Live Chat channel for that store.
 *
 * Callers MUST have already established that `userId` holds
 * `channels:manage:update` in `tenantId`. This function re-checks the
 * entitlement, because a permission says who may act and an entitlement
 * says whether the organization bought the thing being acted on.
 */
export async function bindInstallationToTenant(input: {
  installationId: string;
  tenantId: string;
  userId?: string;
}): Promise<BindResult> {
  const installation = await findInstallationById(input.installationId);
  if (!installation) return { ok: false, reason: "installation_not_found" };
  if (installation.status === "UNINSTALLED") return { ok: false, reason: "installation_uninstalled" };
  if (installation.tenantId && installation.tenantId !== input.tenantId) {
    return { ok: false, reason: "bound_to_other_tenant" };
  }

  const entitled = await isFeatureEnabledForTenant(input.tenantId, FEATURES.SHOPIFY_LIVE_CHAT);
  if (!entitled) return { ok: false, reason: "not_entitled" };

  // Another organization already owns this storefront. The DB's partial
  // unique index makes two live rows impossible; this catches the case
  // where the single live row belongs to somebody else.
  const live = await findLiveInstallation(installation.shopDomain);
  if (live && live.id !== installation.id && live.tenantId && live.tenantId !== input.tenantId) {
    return { ok: false, reason: "shop_taken" };
  }

  const { channel, created } = await ensureChannelForShop({
    tenantId: input.tenantId,
    shopDomain: installation.shopDomain,
    userId: input.userId,
  });

  const row = await withCrossTenantAccess(async () =>
    (prisma as any).shopifyChatInstallation.update({
      where: { id: installation.id },
      data: {
        tenantId: input.tenantId,
        channelAccountId: channel.id,
        status: "ACTIVE",
        boundAt: installation.boundAt ?? new Date(),
      },
    }),
  );

  const bound = toInstallation(row);
  // Learn the merchant's real storefront domain now that a tenant (and so
  // possibly a Core connection) exists. Best-effort: never block binding.
  const domains = await refreshVerifiedDomains(bound).catch(() => bound.verifiedDomains);
  const withDomains = await syncChannelDomains(channel, domains).catch(() => channel);

  return { ok: true, installation: bound, channel: withDomains, created };
}

/**
 * Exactly one channel per (tenant, shop). Reuse is the common case: a
 * merchant who reinstalls, or who ran the old manual flow first, must not
 * end up with two channels racing for the same storefront.
 */
export async function ensureChannelForShop(input: {
  tenantId: string;
  shopDomain: string;
  userId?: string;
}): Promise<{ channel: ShopifyLiveChatChannel; created: boolean }> {
  const existingRows = await prisma.channelAccount.findMany({
    where: { tenantId: input.tenantId, channel: SHOPIFY_LIVE_CHAT as any },
    orderBy: { createdAt: "asc" },
  });

  for (const row of existingRows) {
    const meta = (row.platformMeta as any)?.shopifyLiveChat;
    if (!meta?.shopDomain || meta.shopDomain === input.shopDomain) {
      // An unbound channel (created before the store was known) adopts this
      // shop; a channel already bound to this shop is simply reused.
      if (!meta?.shopDomain) {
        const next = normalizeShopifyLiveChatConfig(
          { shopDomain: input.shopDomain },
          { ...defaultShopifyLiveChatConfig(), ...(meta ?? {}), shopDomain: input.shopDomain },
        );
        const updated = await prisma.channelAccount.update({
          where: { id: row.id },
          data: { platformMeta: { shopifyLiveChat: next } as any },
        });
        const channel = await loadChannel(input.tenantId, updated.id);
        if (channel) return { channel, created: false };
      }
      const channel = await loadChannel(input.tenantId, row.id);
      if (channel) return { channel, created: false };
    }
  }

  const base = defaultShopifyLiveChatConfig();
  base.shopDomain = input.shopDomain;
  const config = normalizeShopifyLiveChatConfig({}, base);
  // Created switched OFF. Installing an app is not the same decision as
  // putting a chat bubble in front of every shopper, and the merchant makes
  // the second one explicitly in step 5 of the wizard.
  config.enabled = false;

  const row = await prisma.channelAccount.create({
    data: {
      tenantId: input.tenantId,
      channel: SHOPIFY_LIVE_CHAT as any,
      externalId: `sfy_${crypto.randomBytes(16).toString("hex")}`,
      displayName: "Shopify Live Chat",
      credentials: {},
      platformMeta: { shopifyLiveChat: config } as any,
      connectionStatus: "DISCONNECTED",
      isActive: false,
      connectedBy: input.userId,
      connectedAt: new Date(),
    },
  });
  const channel = await loadChannel(input.tenantId, row.id);
  if (!channel) throw new Error("channel_create_failed");
  return { channel, created: true };
}

/** Write verified domains into the channel so origin checks see them. */
async function syncChannelDomains(
  channel: ShopifyLiveChatChannel,
  domains: string[],
): Promise<ShopifyLiveChatChannel> {
  const extra = domains.filter((d) => d !== channel.config.shopDomain);
  const merged = [...new Set([...(channel.config.install.storefrontDomains || []), ...extra])];
  if (merged.length === (channel.config.install.storefrontDomains || []).length) return channel;

  const next = normalizeShopifyLiveChatConfig(
    { install: { ...channel.config.install, storefrontDomains: merged } },
    channel.config,
  );
  const row = await prisma.channelAccount.update({
    where: { id: channel.id },
    data: { platformMeta: { shopifyLiveChat: next } as any },
  });
  const reloaded = await loadChannel(channel.tenantId, row.id);
  return reloaded ?? channel;
}

// ─── Uninstall ───────────────────────────────────────────────

/**
 * Retire an installation and stop the storefront widget.
 *
 * Explicitly scoped to Chat: the Core Shopify Integration's
 * `TenantIntegration` row is not read, not written, and not looked at.
 * Conversations are left alone - they are customer records governed by the
 * tenant's retention policy, not app-install state.
 */
export async function markUninstalledByShop(shopDomain: string): Promise<ChatInstallation | null> {
  const installation = await findLiveInstallation(shopDomain);
  if (!installation) return null;

  if (installation.channelAccountId && installation.tenantId) {
    const row = await prisma.channelAccount.findFirst({
      where: { id: installation.channelAccountId, tenantId: installation.tenantId },
    });
    if (row) {
      // Read through the normalizer rather than trusting the stored blob:
      // a partially-written config must still be switchable to off, and an
      // uninstall is the worst moment to throw on a missing field.
      const config = readShopifyLiveChatConfig(row.platformMeta);
      const next = normalizeShopifyLiveChatConfig({ enabled: false }, config);
      await prisma.channelAccount.update({
        where: { id: row.id },
        data: {
          platformMeta: { shopifyLiveChat: next } as any,
          connectionStatus: "DISCONNECTED",
          isActive: false,
          lastError: "Shopify Chat app was uninstalled from the store.",
        },
      });
    }
  }

  const updated = await withCrossTenantAccess(async () =>
    (prisma as any).shopifyChatInstallation.update({
      where: { id: installation.id },
      data: {
        status: "UNINSTALLED",
        uninstalledAt: new Date(),
        // Token material dies with the install. There is nothing to keep.
        accessToken: null,
        tokenScopes: null,
      },
    }),
  );
  return toInstallation(updated);
}

// ─── Heartbeat + activation ──────────────────────────────────

export async function recordInstallationHeartbeat(installationId: string): Promise<void> {
  await withCrossTenantAccess(async () =>
    (prisma as any).shopifyChatInstallation.update({
      where: { id: installationId },
      data: { lastHeartbeatAt: new Date() },
    }),
  ).catch(() => undefined);
}

export interface ActivationSnapshot {
  state: ChatActivationState;
  shopDomain: string;
  tenantId: string | null;
  channelId: string | null;
  channelEnabled: boolean;
  productMessaging: boolean;
  coreConnected: boolean;
  verifiedDomains: string[];
  themeEditorDeepLink: string | null;
  lastHeartbeatAt: Date | null;
}

/**
 * One answer to "where is this merchant right now", used by the wizard, the
 * settings diagnostics and the recovery screen so they can never disagree.
 */
export async function activationSnapshot(installation: ChatInstallation): Promise<ActivationSnapshot> {
  const cfg = getShopifyAppIdentity();
  let channel: ShopifyLiveChatChannel | null = null;
  let tenantActive = false;
  let chatEntitled = false;
  let productEntitled = false;
  let coreConnected = false;

  if (installation.tenantId) {
    const tenant = await withCrossTenantAccess(async () =>
      prisma.tenant.findUnique({
        where: { id: installation.tenantId! },
        select: { status: true, isActive: true },
      }),
    );
    tenantActive = !!tenant && tenant.isActive && tenant.status === "ACTIVE";
    chatEntitled = await isFeatureEnabledForTenant(installation.tenantId, FEATURES.SHOPIFY_LIVE_CHAT);
    productEntitled = await isFeatureEnabledForTenant(
      installation.tenantId,
      FEATURES.SHOPIFY_PRODUCT_MESSAGING,
    );
    if (installation.channelAccountId) {
      channel = await loadChannel(installation.tenantId, installation.channelAccountId);
    }
    const store = await resolveShopifyStore(installation.tenantId).catch(() => ({ ok: false }) as any);
    coreConnected = !!store.ok && store.store?.shopDomain === installation.shopDomain;
  }

  const heartbeat =
    channel?.config.install.lastHeartbeatAt
      ? new Date(channel.config.install.lastHeartbeatAt)
      : installation.lastHeartbeatAt;

  const state = resolveChatActivationState({
    installation: {
      status: installation.status,
      tenantId: installation.tenantId,
      channelAccountId: installation.channelAccountId,
    },
    channelExists: !!channel,
    channelEnabled: !!channel?.config.enabled,
    tenantActive,
    chatEntitled,
    lastHeartbeatAt: heartbeat ?? null,
    coreConnected,
  });

  return {
    state,
    shopDomain: installation.shopDomain,
    tenantId: installation.tenantId,
    channelId: channel?.id ?? null,
    channelEnabled: !!channel?.config.enabled,
    // Honest, not aspirational: product messaging needs the entitlement,
    // the merchant's own switch AND a live Core store connection.
    productMessaging:
      productEntitled && !!channel?.config.commerce.productMessagingEnabled && coreConnected,
    coreConnected,
    verifiedDomains: installation.verifiedDomains,
    themeEditorDeepLink: buildThemeEditorDeepLink({
      shopDomain: installation.shopDomain,
      clientId: cfg.clientId,
      blockHandle: cfg.blockHandle,
    }),
    lastHeartbeatAt: heartbeat ?? null,
  };
}

// ─── Unified app: enable / disable without a second OAuth ─────

/**
 * Turn Shopify Chat on for a tenant that already has Shopify connected.
 *
 * Under the unified app there is no second install to perform. The merchant
 * authorized ONE Shopify app; the Theme App Extension ships with it, and
 * enabling chat is a GOTCHA-side decision, not a Shopify handshake. So this
 * derives the shop from the Core integration rather than from an OAuth
 * callback, and records an installation row carrying no token at all - the
 * storefront never needed Admin access, and now there is no second grant it
 * could even draw one from.
 *
 * Idempotent: enabling an already-enabled channel returns the same channel.
 */
export async function enableChatForTenant(input: {
  tenantId: string;
  userId?: string;
}): Promise<
  | { ok: true; installation: ChatInstallation; channel: ShopifyLiveChatChannel; created: boolean }
  | { ok: false; reason: "shopify_not_connected" | "not_entitled" | "shop_taken" | "bound_to_other_tenant" | "installation_not_found" | "installation_uninstalled" }
> {
  // The Core connection is the only source of the shop domain. Accepting one
  // from the caller would let a tenant claim a storefront it never connected.
  const conn = await loadConnection({ tenantId: input.tenantId, slug: "shopify" }).catch(() => null);
  const shopDomain = normalizeShopifyShopDomain((conn?.config as any)?.shopDomain ?? "");
  if (!conn || !shopDomain) return { ok: false, reason: "shopify_not_connected" };

  const installation = await recordAuthorizedInstall({ shopDomain, accessToken: null, scopes: null });
  const bound = await bindInstallationToTenant({
    installationId: installation.id,
    tenantId: input.tenantId,
    userId: input.userId,
  });
  if (!bound.ok) return { ok: false, reason: bound.reason };

  return { ok: true, installation: bound.installation, channel: bound.channel, created: bound.created };
}

/**
 * Turn Shopify Chat off for a tenant.
 *
 * Switches the CHANNEL off and leaves the Shopify connection completely
 * alone: a merchant who no longer wants a storefront widget still wants
 * their order and customer tools. The installation row stays too, so
 * re-enabling does not lose the widget configuration or the verified
 * domain list.
 *
 * The App Embed in the merchant's theme is a separate switch that only they
 * can flip. Disabling here stops the server answering bootstrap, so the
 * widget goes away either way - but the embed remains in the theme, and the
 * UI says so rather than implying GOTCHA removed it.
 */
export async function disableChatForTenant(input: {
  tenantId: string;
}): Promise<{ ok: boolean; disabled: number }> {
  const rows = await prisma.channelAccount.findMany({
    where: { tenantId: input.tenantId, channel: SHOPIFY_LIVE_CHAT as any },
  });
  let disabled = 0;
  for (const row of rows) {
    const config = readShopifyLiveChatConfig(row.platformMeta);
    if (!config.enabled) continue;
    const next = normalizeShopifyLiveChatConfig({ enabled: false }, config);
    await prisma.channelAccount.update({
      where: { id: row.id },
      data: { platformMeta: { shopifyLiveChat: next } as any, isActive: false },
    });
    disabled++;
  }
  return { ok: true, disabled };
}

/**
 * The commerce app was uninstalled, so the storefront chat it carried is
 * gone too.
 *
 * Under two apps a chat uninstall and a commerce uninstall were separate
 * events with separate consequences. With one app Shopify sends ONE
 * `app/uninstalled`, and the extension leaves with it - so the honest
 * response is to disable the channel as well as the connection.
 *
 * Deliberately preserves conversations, messages and audit history: the
 * merchant's support record is theirs and survives an integration being
 * removed. Only the ability to serve NEW storefront chat stops.
 */
export async function disableChatForUninstalledShop(shopDomain: string): Promise<{ disabled: boolean }> {
  const installation = await markUninstalledByShop(shopDomain);
  return { disabled: !!installation };
}
