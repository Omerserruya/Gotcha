/**
 * The Website widget (docs/api/website-widget-v1.md): ONE settings object over
 * the places the widget lives - the web chat account (the code snippet) and
 * every Shopify live chat account of the workspace. Stage A of
 * docs/product/website-widget.md.
 *
 * Nothing new is stored. The shared settings are written into each place's
 * own config through that place's own normaliser (WebchatConfig in
 * credentials, ShopifyLiveChatConfig in platformMeta), so both public APIs and
 * the bundle keep reading exactly what they read today. Shopify-only fields
 * (commerce, privacy, offline behaviour, the shop binding) are never touched
 * here.
 */
import {
  prisma,
  normalizeWebchatConfig,
  readShopifyLiveChatConfig,
  waMeDigits,
  getRedis,
  HANDOFF_TTL_SECONDS,
  handoffRefKey,
  newHandoffRef,
  type HandoffRecord,
  type WebchatConfig,
  type ShopifyChatUx,
} from "@chatcenter/shared";
import { listChannels, saveChannelConfig } from "./shopify-live-chat.service";
import { activationSnapshot } from "./shopify-chat-install.service";
import { entryFor } from "./employee-reach.service";
import { splitErrorCode } from "../lib/error-code";

export interface WidgetSettings {
  appearance: WebchatConfig["appearance"];
  ux: WebchatConfig["ux"];
  handoff: { allowHumanHandoff: boolean };
  offline: { message: string };
}

/** The settings as a webchat config sees them (the canonical projection). */
function fromWebchat(c: WebchatConfig): WidgetSettings {
  return {
    appearance: c.appearance,
    ux: c.ux,
    handoff: { allowHumanHandoff: c.behaviour.allowHumanHandoff },
    offline: { message: c.offline.message },
  };
}

/** A Shopify chat config, projected onto the same shape (for a workspace with no web chat yet). */
function fromShopify(platformMeta: unknown): WidgetSettings {
  const s = readShopifyLiveChatConfig(platformMeta);
  const base = normalizeWebchatConfig(null);
  return {
    appearance: {
      ...base.appearance,
      primaryColor: s.appearance.primaryColor,
      contrastColor: s.appearance.contrastColor,
      logoUrl: s.appearance.logoUrl,
      cornerRadius: s.appearance.cornerRadius,
      language: s.appearance.language as any,
      direction: s.appearance.direction as any,
      showPoweredBy: s.appearance.showPoweredBy,
    },
    ux: s.ux,
    handoff: { allowHumanHandoff: s.routing.allowHumanHandoff },
    offline: { message: s.hours.offlineMessage },
  };
}

/**
 * The patch applied to a webchat config: normalised by the webchat
 * normaliser against the current config, so invalid values fall back.
 */
function nextWebchat(current: WebchatConfig, patch: Partial<WidgetSettings>): WebchatConfig {
  return normalizeWebchatConfig({
    v: 2,
    displayName: current.displayName,
    appearance: { ...current.appearance, ...(patch.appearance ?? {}) },
    ux: patch.ux ? deepMerge(current.ux, patch.ux) : current.ux,
    behaviour: { ...current.behaviour, ...(patch.handoff ? { allowHumanHandoff: patch.handoff.allowHumanHandoff } : {}) },
    offline: { ...current.offline, ...(patch.offline ?? {}) },
  }, current);
}

function deepMerge(base: any, patch: any): any {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch ?? base;
  const out: any = { ...(base ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) ? deepMerge(base?.[k], v) : v;
  }
  return out;
}

/** The shared settings as a Shopify config patch: only the shared sections. */
export function shopifyPatchOf(s: WidgetSettings): Record<string, unknown> {
  return {
    appearance: {
      primaryColor: s.appearance.primaryColor,
      contrastColor: s.appearance.contrastColor,
      logoUrl: s.appearance.logoUrl,
      cornerRadius: s.appearance.cornerRadius,
      language: s.appearance.language,
      direction: s.appearance.direction,
      showPoweredBy: s.appearance.showPoweredBy,
      // The storefront's public config still serves these three from
      // appearance; the web chat serves them from ux. Kept in step.
      avatarUrl: s.ux.welcome.avatarUrl,
      launcherIcon: s.ux.launcher.icon,
      launcherPosition: s.ux.launcher.position,
    },
    ux: s.ux,
    // The legacy welcome block is still read by older storefront code: kept
    // in step with ux.welcome, never left saying something else.
    welcome: {
      headline: s.ux.welcome.title,
      subline: s.ux.welcome.subtitle,
      assistantName: s.ux.welcome.assistantName,
      suggestedQuestions: s.ux.welcome.suggestedQuestions,
    },
    routing: { allowHumanHandoff: s.handoff.allowHumanHandoff },
    hours: { offlineMessage: s.offline.message },
  };
}

/**
 * Who answers the website channel according to the playbook: the first route
 * to an AI employee on the single path from the web chat's channel entry.
 * Null when the path branches before reaching one (it depends) or routes to a
 * team; the playbook stays the one place that decides.
 */
export async function assignedEmployeeOf(tenantId: string): Promise<{ id: string; name: string } | null> {
  const canvas = await (prisma as any).flowCanvas.findUnique({ where: { tenantId }, select: { nodes: true, edges: true } });
  const nodes: any[] = Array.isArray(canvas?.nodes) ? canvas.nodes : [];
  const edges: any[] = Array.isArray(canvas?.edges) ? canvas.edges : [];
  // The same entry the flow executor uses for a web chat inbound.
  const entry = entryFor(nodes, "WEBCHAT");
  let cur = entry;
  for (let i = 0; cur && i < 30; i++) {
    const routeType = cur?.data?.routeType ?? (cur?.data?.targetId ? "agent" : null);
    if (cur !== entry && routeType === "agent" && cur?.data?.targetId) {
      const agent = await prisma.aIAgent.findFirst({ where: { id: String(cur.data.targetId), tenantId }, select: { id: true, name: true } });
      return agent ? { id: agent.id, name: agent.name } : null;
    }
    const out = edges.filter((e) => e?.source === cur.id);
    if (out.length !== 1) return null;
    cur = nodes.find((n) => n?.id === out[0].target);
  }
  return null;
}

/** The workspace's WhatsApp numbers, for "Continue on WhatsApp", and whether each can take it. */
export async function whatsappNumbers(tenantId: string): Promise<Array<{ channelId: string; name: string; phone: string | null; available: boolean; reason?: "not_connected" | "number_unknown" }>> {
  const accounts = await prisma.channelAccount.findMany({
    where: { tenantId, channel: "WHATSAPP" as any },
    select: { id: true, displayName: true, connectionStatus: true, isActive: true },
    orderBy: { createdAt: "asc" },
  });
  if (!accounts.length) return [];
  const numbers = await (prisma as any).whatsAppNumber.findMany({
    where: { tenantId, channelAccountId: { in: accounts.map((a) => a.id) } },
    select: { channelAccountId: true, displayPhoneNumber: true },
  });
  const phoneOf = new Map<string, string | null>((numbers as any[]).map((n) => [n.channelAccountId, n.displayPhoneNumber ?? null]));
  return accounts.map((a) => {
    const phone = phoneOf.get(a.id) ?? null;
    const connected = a.connectionStatus === "CONNECTED" && a.isActive;
    // A number connected before WhatsAppNumber rows existed has no known phone: wa.me needs one.
    const reason = !connected ? "not_connected" as const : !waMeDigits(phone) ? "number_unknown" as const : undefined;
    return { channelId: a.id, name: a.displayName || phone || "WhatsApp", phone, available: !reason, ...(reason ? { reason } : {}) };
  });
}

/** The wa.me digits the handoff opens, or null when the button must not show. */
export async function handoffTarget(tenantId: string, ux: ShopifyChatUx): Promise<{ channelAccountId: string; digits: string } | null> {
  if (!ux.whatsapp.enabled || !ux.whatsapp.channelAccountId) return null;
  const n = (await whatsappNumbers(tenantId)).find((x) => x.channelId === ux.whatsapp.channelAccountId);
  const digits = n?.available ? waMeDigits(n.phone) : null;
  return digits ? { channelAccountId: n!.channelId, digits } : null;
}

/**
 * A new handoff code for `record`, stored for a week. Null when five random
 * codes in a row were taken (the caller answers "try again").
 */
export async function mintHandoffRef(record: HandoffRecord, random: (n: number) => Uint8Array): Promise<string | null> {
  const redis = getRedis();
  for (let i = 0; i < 5; i++) {
    const candidate = newHandoffRef(random);
    if (await redis.set(handoffRefKey(candidate), JSON.stringify(record), "EX", HANDOFF_TTL_SECONDS, "NX")) return candidate;
  }
  return null;
}

export class WidgetInputError extends Error {
  constructor(public code: string, public field: string) { super(code); }
}

export async function getWidget(tenantId: string) {
  const [webchat, shops] = await Promise.all([
    prisma.channelAccount.findFirst({ where: { tenantId, channel: "WEBCHAT" as any }, orderBy: { createdAt: "asc" } }),
    listChannels(tenantId),
  ]);
  const settings = webchat
    ? fromWebchat(normalizeWebchatConfig(webchat.credentials))
    : shops[0]
      ? fromShopify({ shopifyLiveChat: shops[0].config })
      : fromWebchat(normalizeWebchatConfig(null));
  return {
    settings,
    assignedEmployee: await assignedEmployeeOf(tenantId).catch(() => null),
    // For "Continue on WhatsApp": the numbers to choose from, each with whether it can take it.
    whatsappNumbers: await whatsappNumbers(tenantId),
    places: {
      code: webchat ? { channelId: webchat.id } : null,
      shopify: shops.map((s) => ({ channelId: s.id, shopDomain: s.config.shopDomain })),
    },
  };
}

/**
 * Apply a partial settings object to every place. Returns null when the
 * workspace has no place yet (the web chat is created by
 * POST /api/channels/webchat/create, which owns the plan's channel limit).
 */
export async function putWidget(tenantId: string, patch: Partial<WidgetSettings>) {
  const [webchat, shops] = await Promise.all([
    prisma.channelAccount.findFirst({ where: { tenantId, channel: "WEBCHAT" as any }, orderBy: { createdAt: "asc" } }),
    listChannels(tenantId),
  ]);
  if (!webchat && !shops.length) return null;
  // A WhatsApp number for the handoff must be one of this workspace's.
  const chosen = (patch.ux as any)?.whatsapp?.channelAccountId;
  if (typeof chosen === "string" && chosen) {
    const owned = await prisma.channelAccount.findFirst({ where: { id: chosen, tenantId, channel: "WHATSAPP" as any }, select: { id: true } });
    if (!owned) throw new WidgetInputError("WHATSAPP_NUMBER_NOT_FOUND", "ux.whatsapp.channelAccountId");
  }
  // One canonical result, from the webchat normaliser, then written everywhere.
  const current = webchat
    ? normalizeWebchatConfig(webchat.credentials)
    : normalizeWebchatConfig({ v: 2, ...fromShopify({ shopifyLiveChat: shops[0]!.config }), behaviour: { allowHumanHandoff: fromShopify({ shopifyLiveChat: shops[0]!.config }).handoff.allowHumanHandoff } });
  const next = nextWebchat(current, patch);
  // The WhatsApp kind has no on-site chat: without a number that can take
  // the conversation it would be a widget that does nothing. Checked when the
  // save chooses the kind or the number, so a number that disconnects later
  // does not block saving a colour (the bootstrap then draws nothing).
  const choosing = !!patch.ux && ("kind" in (patch.ux as any) || "whatsapp" in (patch.ux as any));
  if (choosing && next.ux.kind === "whatsapp" && !(await handoffTarget(tenantId, next.ux))) {
    throw new WidgetInputError("WHATSAPP_KIND_NEEDS_NUMBER", "ux.kind");
  }
  if (webchat) {
    await prisma.channelAccount.update({ where: { id: webchat.id }, data: { credentials: next as any } });
  }
  const shared = fromWebchat(next);
  for (const shop of shops) {
    await saveChannelConfig(shop, shopifyPatchOf(shared));
  }
  return getWidget(tenantId);
}

const HOUR = 60 * 60_000;

/** The public origin the snippet points at. */
function publicOrigin(): string {
  return String(process.env.APP_PUBLIC_URL || process.env.FRONTEND_URL || "").replace(/\/+$/, "");
}

export function snippetFor(widgetId: string, origin = publicOrigin()): string {
  const api = JSON.stringify(origin);
  return `<script>window.__chatcenter = { widgetId: ${JSON.stringify(widgetId)}, apiUrl: ${api} };</script>\n<script src=${JSON.stringify(`${origin}/widget/chatcenter-widget.js`)} async></script>`;
}

export async function installOf(tenantId: string, now = new Date()) {
  const [webchat, shops, installations] = await Promise.all([
    prisma.channelAccount.findFirst({ where: { tenantId, channel: "WEBCHAT" as any }, orderBy: { createdAt: "asc" } }),
    listChannels(tenantId),
    (prisma as any).shopifyChatInstallation.findMany({ where: { tenantId } }),
  ]);
  const seen = (webchat?.platformMeta as any)?.webchatInstall ?? {};
  const shopify = [];
  for (const ch of shops) {
    const inst = (installations as any[]).find((i) => i.channelAccountId === ch.id || i.shopDomain === ch.config.shopDomain);
    const snap = inst ? await activationSnapshot(inst).catch(() => null) : null;
    const last = snap?.lastHeartbeatAt ?? (ch.config.install.lastHeartbeatAt ? new Date(ch.config.install.lastHeartbeatAt) : null);
    shopify.push({
      channelId: ch.id,
      shopDomain: ch.config.shopDomain,
      status: inst?.status === "UNINSTALLED" ? "uninstalled" : ch.config.enabled ? "active" : "not_enabled",
      // The theme's app embed loaded within a week (the diagnostics' own window).
      embedLive: !!last && now.getTime() - last.getTime() < 7 * 24 * HOUR,
      lastHeartbeatAt: last ? last.toISOString() : null,
      themeEditorUrl: snap?.themeEditorDeepLink ?? null,
    });
  }
  const woocommerce = await woocommerceInstall(tenantId);
  return {
    platforms: await commercePlatforms(tenantId, shopify, woocommerce),
    code: webchat
      ? {
          widgetId: webchat.externalId,
          snippet: snippetFor(webchat.externalId),
          status: webchat.connectionStatus === "CONNECTED" ? "live" : "not_seen",
          firstSeenAt: webchat.connectedAt ? webchat.connectedAt.toISOString() : null,
          lastSeenAt: webchat.lastHealthCheck ? webchat.lastHealthCheck.toISOString() : null,
          lastHost: typeof seen.lastHost === "string" ? seen.lastHost : null,
        }
      : null,
    shopify,
    // The plugin's sites (docs/api/woocommerce-plugin-v1.md §5); the code
    // snippet stays the way until one is connected.
    woocommerce,
  };
}

const COMMERCE_SLUGS = ["shopify", "woocommerce"] as const;
type CommercePlatform = (typeof COMMERCE_SLUGS)[number];
export type DataStatus = "connected" | "connecting" | "error" | "not_connected";
export type ChatStatus = "active" | "not_enabled" | "uninstalled" | "plugin" | "none";

/** A TenantIntegration status, as the install step needs it. */
export function dataStatusOf(row: { status: string; lastError: string | null } | null): DataStatus {
  if (!row) return "not_connected";
  if (row.status === "CONNECTED") return "connected";
  if (row.status === "PENDING" || row.status === "TESTING") return "connecting";
  // ERROR, or DISCONNECTED because something broke (a failed token refresh).
  return row.status === "ERROR" || row.lastError ? "error" : "not_connected";
}

/**
 * W11: which commerce platforms the workspace is connected to, for the
 * install step. Two facts per platform, never merged, because they can
 * disagree: `data` is the store connection the AI reads (TenantIntegration),
 * `chat` is where the widget is installed (the Shopify chat channel, the
 * WooCommerce plugin). "chat live, data broken" is a state worth showing.
 */
async function commercePlatforms(
  tenantId: string,
  shopify: Array<{ shopDomain: string | null; status: string }>,
  woocommerce: { status: "plugin" | "use_code"; sites: Array<{ siteUrl: string; status: string }> },
) {
  const rows = await prisma.tenantIntegration.findMany({
    where: { tenantId, integration: { slug: { in: [...COMMERCE_SLUGS] } } },
    select: { status: true, lastError: true, config: true, integration: { select: { slug: true } } },
  });
  const rowOf = (slug: CommercePlatform) => (rows as any[]).find((r) => r.integration?.slug === slug) ?? null;
  const errorOf = (row: any) => (row && dataStatusOf(row) === "error" ? splitErrorCode(row.lastError).lastErrorCode : null);

  const sh = rowOf("shopify");
  const shopChat: ChatStatus = shopify.some((s) => s.status === "active") ? "active"
    : shopify.some((s) => s.status === "not_enabled") ? "not_enabled"
    : shopify.some((s) => s.status === "uninstalled") ? "uninstalled"
    : "none";
  const wo = rowOf("woocommerce");
  const storeUrl = typeof (wo?.config as any)?.storeUrl === "string" ? (wo!.config as any).storeUrl as string : null;
  return [
    {
      platform: "shopify" as const,
      data: dataStatusOf(sh),
      dataErrorCode: errorOf(sh),
      chat: shopChat,
      stores: shopify.map((s) => s.shopDomain).filter((d): d is string => !!d),
    },
    {
      platform: "woocommerce" as const,
      data: dataStatusOf(wo),
      dataErrorCode: errorOf(wo),
      chat: (woocommerce.status === "plugin" ? "plugin" : "none") as ChatStatus,
      stores: [...new Set([...(storeUrl ? [storeUrl] : []), ...woocommerce.sites.filter((x) => x.status === "connected").map((x) => x.siteUrl)])],
    },
  ];
}

/**
 * The code snippet loaded on a page: last seen + host, at most hourly (it runs
 * on every page view of every visitor). One statement: the throttle is in the
 * WHERE (two visitors in the same second write once) and only the
 * `webchatInstall` key of platformMeta is replaced, never the rest of it.
 * Best-effort; never blocks the widget.
 */
export async function recordWebchatSeen(accountId: string, host: string | null, now = new Date()): Promise<boolean> {
  const since = new Date(now.getTime() - HOUR);
  const n = await prisma.$executeRaw`
    UPDATE "channel_accounts"
       SET "last_health_check" = ${now},
           "platform_meta" = CASE WHEN ${host}::text IS NULL THEN "platform_meta"
             ELSE COALESCE("platform_meta", '{}'::jsonb) || jsonb_build_object('webchatInstall', jsonb_build_object('lastHost', ${host}::text)) END
     WHERE "id" = ${accountId}
       AND ("last_health_check" IS NULL OR "last_health_check" < ${since})`;
  return n > 0;
}

/** The page's host, from the browser's own headers (never from the body). */
export function hostOf(origin: unknown, referer: unknown): string | null {
  for (const v of [origin, referer]) {
    if (typeof v !== "string" || !v) continue;
    try {
      const h = new URL(v).hostname.toLowerCase();
      if (h) return h.slice(0, 255);
    } catch { /* not a URL */ }
  }
  return null;
}

async function woocommerceInstall(tenantId: string) {
  const { sitesForInstall } = await import("./woocommerce-plugin.service");
  const sites = await sitesForInstall(tenantId).catch(() => []);
  return {
    status: sites.some((s) => s.status === "connected") ? ("plugin" as const) : ("use_code" as const),
    sites,
    downloadUrl: "/api/woocommerce-plugin/download",
  };
}
