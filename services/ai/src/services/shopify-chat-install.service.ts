/**
 * GOTCHA Shopify Chat App — installation lifecycle.
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
  getShopifyChatAppConfig,
  buildThemeEditorDeepLink,
  isFeatureEnabledForTenant,
  FEATURES,
  type ChatActivationState,
} from "@chatcenter/shared";
import { SHOPIFY_LIVE_CHAT, loadChannel, type ShopifyLiveChatChannel } from "./shopify-live-chat.service";
import { resolveShopifyStore } from "./shopify-catalog.service";
import { executeAdapterTool } from "./connectors/integration-framework";

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

/** Including retired rows — used by reinstall and by audit surfaces. */
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
        appIdentity: getShopifyChatAppConfig().appHandle || "gotcha-chat",
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
 * Shopify — so we ask the Core connection when there is one, and we never
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
 * Conversations are left alone — they are customer records governed by the
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
  const cfg = getShopifyChatAppConfig();
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
