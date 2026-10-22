/**
 * "GOTCHA for WooCommerce" (docs/api/woocommerce-plugin-v1.md): the backend
 * side of the plugin's Connect, its signals, and the sites a workspace has.
 *
 * Kept in a durable tenant setting (`woocommerce_plugin_sites`, no
 * migration). A site key is a secret shown once; only its SHA-256 is kept,
 * and a Redis index maps it to the workspace (rebuilt from the setting when
 * missing).
 */
import crypto from "crypto";
import { prisma, getRedis, readDurableSetting, writeDurableSetting } from "@chatcenter/shared";

export const SETTING_KEY = "woocommerce_plugin_sites";
const CODE_TTL_SECONDS = 600;
const HEARTBEAT_EVERY_MS = 20 * 3600_000; // at most one recorded a day (with slack)

export type SiteStatus = "connected" | "deactivated" | "removed";
export interface PluginSite {
  id: string;
  siteUrl: string;
  keyHash: string;
  status: SiteStatus;
  connectedAt: string;
  lastSeenAt: string | null;
  pluginVersion: string | null;
  wpVersion: string | null;
  wcVersion: string | null;
}

export class PluginError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

const codeKey = (code: string) => `wcplugin:code:${code}`;
const indexKey = (hash: string) => `wcplugin:key:${hash}`;
const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/** https://host[:port][/path] without a trailing slash, lowercased host; null when not a URL. */
export function normalizeSite(raw: unknown): string | null {
  try {
    const u = new URL(String(raw ?? "").trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.protocol}//${u.host.toLowerCase()}${path}`;
  } catch {
    return null;
  }
}
const hostOf = (url: string) => { try { return new URL(url).host.toLowerCase(); } catch { return ""; } };

export async function readSites(tenantId: string): Promise<PluginSite[]> {
  const raw = await readDurableSetting(tenantId, SETTING_KEY).catch(() => null);
  try { const v = raw ? JSON.parse(raw) : []; return Array.isArray(v) ? v : []; } catch { return []; }
}
async function writeSites(tenantId: string, sites: PluginSite[], userId?: string | null): Promise<void> {
  await writeDurableSetting(tenantId, SETTING_KEY, JSON.stringify(sites), userId ?? undefined);
}

/** The workspace's WooCommerce connection's store, if any. */
async function connectedStoreUrl(tenantId: string): Promise<string | null> {
  const row = await prisma.tenantIntegration.findFirst({
    where: { tenantId, status: "CONNECTED" as any, integration: { slug: "woocommerce" } },
    select: { config: true },
  });
  return normalizeSite((row?.config as any)?.storeUrl);
}

async function webchatOf(tenantId: string) {
  return prisma.channelAccount.findFirst({ where: { tenantId, channel: "WEBCHAT" as any }, orderBy: { createdAt: "asc" }, select: { externalId: true } });
}

/** §2.3: a single-use code for the plugin, bound to the workspace, the site and the plugin's nonce. */
export async function bindSite(tenantId: string, body: { siteUrl?: unknown; returnUrl?: unknown; nonce?: unknown }): Promise<{ redirect: string }> {
  const siteUrl = normalizeSite(body.siteUrl);
  const store = await connectedStoreUrl(tenantId);
  if (!siteUrl || !store || hostOf(store) !== hostOf(siteUrl)) throw new PluginError(409, "STORE_NOT_CONNECTED");
  const returnUrl = String(body.returnUrl ?? "");
  let ret: URL;
  try { ret = new URL(returnUrl); } catch { throw new PluginError(422, "BAD_RETURN_URL"); }
  if (ret.host.toLowerCase() !== hostOf(siteUrl) || !ret.pathname.includes("/wp-admin/") || !/^https?:$/.test(ret.protocol)) throw new PluginError(422, "BAD_RETURN_URL");
  const nonce = String(body.nonce ?? "");
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(nonce)) throw new PluginError(422, "BAD_NONCE");
  if (!(await webchatOf(tenantId))) throw new PluginError(409, "WIDGET_NOT_CREATED");
  const code = crypto.randomBytes(24).toString("base64url");
  await getRedis().set(codeKey(code), JSON.stringify({ tenantId, siteUrl, nonce }), "EX", CODE_TTL_SECONDS);
  ret.searchParams.set("gotcha_code", code);
  ret.searchParams.set("nonce", nonce);
  return { redirect: ret.toString() };
}

/** §2.4: the plugin's server trades the code for its widget id and a site key (shown once). */
export async function exchangeCode(body: { code?: unknown; siteUrl?: unknown }, origin: string) {
  const code = String(body.code ?? "");
  const r = getRedis();
  // Single use: read and delete together.
  const res = code ? await r.multi().get(codeKey(code)).del(codeKey(code)).exec() : null;
  const raw = res?.[0]?.[1] as string | null | undefined;
  if (!raw) throw new PluginError(410, "CODE_EXPIRED");
  const claim = JSON.parse(raw) as { tenantId: string; siteUrl: string };
  const siteUrl = normalizeSite(body.siteUrl);
  if (!siteUrl || hostOf(siteUrl) !== hostOf(claim.siteUrl)) throw new PluginError(409, "SITE_MISMATCH");
  const webchat = await webchatOf(claim.tenantId);
  if (!webchat?.externalId) throw new PluginError(409, "WIDGET_NOT_CREATED");
  const tenant = await prisma.tenant.findUnique({ where: { id: claim.tenantId }, select: { name: true } });

  const siteKey = `gws_${crypto.randomBytes(32).toString("base64url")}`;
  const keyHash = sha256(siteKey);
  const sites = await readSites(claim.tenantId);
  const now = new Date().toISOString();
  const existing = sites.find((s) => hostOf(s.siteUrl) === hostOf(claim.siteUrl));
  if (existing?.keyHash) await r.del(indexKey(existing.keyHash)).catch(() => undefined); // the old key stops working
  const site: PluginSite = {
    id: existing?.id ?? crypto.randomBytes(8).toString("hex"), siteUrl: claim.siteUrl, keyHash, status: "connected",
    connectedAt: now, lastSeenAt: now, pluginVersion: existing?.pluginVersion ?? null, wpVersion: existing?.wpVersion ?? null, wcVersion: existing?.wcVersion ?? null,
  };
  await writeSites(claim.tenantId, [...sites.filter((s) => s !== existing), site]);
  await r.set(indexKey(keyHash), claim.tenantId);
  return {
    widgetId: webchat.externalId, siteKey, apiUrl: origin, scriptUrl: `${origin}/widget/chatcenter-widget.js`,
    workspaceName: tenant?.name ?? null,
  };
}

/** The workspace a site key belongs to (the Redis index, rebuilt from the setting when missing). */
async function tenantOfKey(keyHash: string): Promise<string | null> {
  const r = getRedis();
  const hit = await r.get(indexKey(keyHash)).catch(() => null);
  if (hit) return hit;
  // The value is JSON: searched as text (the hash is hex, nothing to escape).
  const rows = await prisma.$queryRaw<Array<{ tenant_id: string }>>`
    SELECT tenant_id FROM tenant_settings WHERE key = ${SETTING_KEY} AND value::text LIKE ${"%" + keyHash + "%"} LIMIT 2`.catch(() => []);
  if (rows.length !== 1) return null;
  const tenantId = rows[0]!.tenant_id;
  const site = (await readSites(tenantId)).find((s) => s.keyHash === keyHash && s.status !== "removed");
  if (!site) return null;
  await r.set(indexKey(keyHash), tenantId).catch(() => undefined);
  return tenantId;
}

const EVENTS = new Set(["activated", "deactivated", "uninstalled", "disconnected", "heartbeat"]);
const version = (v: unknown) => (typeof v === "string" && /^[0-9][0-9A-Za-z.\-+]{0,30}$/.test(v) ? v : null);

/** §3: activation, deactivation, uninstall, disconnect and the daily heartbeat. */
export async function signal(bearer: string | undefined, body: Record<string, unknown>): Promise<void> {
  const key = String(bearer ?? "").replace(/^Bearer\s+/i, "");
  if (!key.startsWith("gws_")) throw new PluginError(401, "UNKNOWN_SITE");
  const keyHash = sha256(key);
  const tenantId = await tenantOfKey(keyHash);
  if (!tenantId) throw new PluginError(401, "UNKNOWN_SITE");
  const event = String(body.event ?? "");
  if (!EVENTS.has(event)) throw new PluginError(422, "UNKNOWN_EVENT");
  const sites = await readSites(tenantId);
  const site = sites.find((s) => s.keyHash === keyHash);
  if (!site || site.status === "removed") throw new PluginError(401, "UNKNOWN_SITE");
  const now = new Date();
  if (event === "heartbeat" && site.lastSeenAt && now.getTime() - Date.parse(site.lastSeenAt) < HEARTBEAT_EVERY_MS) return;
  site.lastSeenAt = now.toISOString();
  site.pluginVersion = version(body.pluginVersion) ?? site.pluginVersion;
  site.wpVersion = version(body.wpVersion) ?? site.wpVersion;
  site.wcVersion = version(body.wcVersion) ?? site.wcVersion;
  if (event === "activated" || event === "heartbeat") site.status = "connected";
  if (event === "deactivated") site.status = "deactivated";
  if (event === "uninstalled" || event === "disconnected") {
    site.status = "removed";
    await getRedis().del(indexKey(keyHash)).catch(() => undefined); // revoked
  }
  await writeSites(tenantId, sites);
}

/** §4: removed from GOTCHA; the plugin's next signal gets 401. */
export async function removeSite(tenantId: string, id: string, userId: string | null): Promise<boolean> {
  const sites = await readSites(tenantId);
  const site = sites.find((s) => s.id === id);
  if (!site) return false;
  site.status = "removed";
  await getRedis().del(indexKey(site.keyHash)).catch(() => undefined);
  await writeSites(tenantId, sites, userId);
  return true;
}

/** For the Install screen: never the key hash. */
export async function sitesForInstall(tenantId: string) {
  return (await readSites(tenantId)).map(({ keyHash: _k, ...s }) => ({
    id: s.id, siteUrl: s.siteUrl, status: s.status, lastSeenAt: s.lastSeenAt, pluginVersion: s.pluginVersion,
  }));
}
