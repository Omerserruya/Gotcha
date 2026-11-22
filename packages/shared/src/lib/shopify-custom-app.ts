/**
 * Per-merchant Shopify custom distribution apps (2026-11-22, Omer, path A).
 *
 * While the official listing is not live, a workspace can ask for a store link: we create a custom
 * distribution app for that one store in Shopify's Dev Dashboard, deploy the official app's config to it,
 * and paste its client id, secret and install link in the console. The merchant installs through the
 * SAME install, OAuth, callback and claim path as the official app. The only difference is billing: a
 * custom distribution app cannot use Shopify's Billing API, so the Shopify-funded capabilities come from a
 * GOTCHA-side grant (billing: source ADDON, reason "shopify_custom_app").
 *
 * Storage, no migration:
 *   - the record: a durable setting on the requesting workspace, key "shopifyCustomApp";
 *   - the platform switch: a durable setting on the System organization, key "shopifyPrivateApps"
 *     ({ enabled, entitlement }), default OFF.
 *
 * Every Shopify signature check resolves the app by shop (or client id) through this module and verifies
 * with THAT app's secret, the official app being the fallback. A secret of an app we do not know is never
 * a candidate.
 */
import { prisma, withCrossTenantAccess } from "./prisma";
import { readDurableSetting, writeDurableSetting } from "./durable-settings";
import { encryptCredentials, decryptCredentials } from "./encryption";
import { normalizeShopifyShopDomain, verifyShopifyWebhookHmac } from "./shopify-chat-app";
import { verifyAppEntryHmac, verifyOAuthCallbackHmac } from "./shopify-install";

export const CUSTOM_APP_KEY = "shopifyCustomApp";
export const PRIVATE_APPS_KEY = "shopifyPrivateApps";
/** The billing grant's marker on a tenant_entitlements row (source ADDON). */
export const CUSTOM_APP_GRANT_REASON = "shopify_custom_app";
/** The install link Shopify generates lasts a week. */
export const INSTALL_LINK_TTL_MS = 7 * 24 * 3600 * 1000;

export type CustomAppStatus = "requested" | "link_sent" | "installed" | "revoked";
export interface CustomAppRecord {
  status: CustomAppStatus;
  shopDomain: string;
  requestedAt: string;
  requestedBy: string | null;
  clientId?: string | null;
  /** encryptCredentials({ clientSecret }); never returned to any browser. */
  clientSecretEnc?: string | null;
  installLink?: string | null;
  linkExpiresAt?: string | null;
  linkSentAt?: string | null;
  installedAt?: string | null;
  revokedAt?: string | null;
  revokedReason?: string | null;
}

export interface PrivateAppsSettings {
  enabled: boolean;
  /** "included": the capabilities are granted at connect (Core covers them); "manual": a person grants. */
  entitlement: "included" | "manual";
}
export const PRIVATE_APPS_DEFAULTS: PrivateAppsSettings = Object.freeze({ enabled: false, entitlement: "included" }) as PrivateAppsSettings;

export function parsePrivateAppsSettings(raw: string | null | undefined): PrivateAppsSettings {
  try {
    const v = raw ? JSON.parse(raw) : null;
    return {
      enabled: v?.enabled === true,
      entitlement: v?.entitlement === "manual" ? "manual" : "included",
    };
  } catch {
    return { ...PRIVATE_APPS_DEFAULTS };
  }
}

async function systemTenant(): Promise<string | null> {
  const row = await withCrossTenantAccess(() => (prisma as any).tenant.findUnique({ where: { slug: "system" }, select: { id: true } }));
  return (row as any)?.id ?? null;
}

export async function readPrivateAppsSettings(): Promise<PrivateAppsSettings> {
  const id = await systemTenant().catch(() => null);
  if (!id) return { ...PRIVATE_APPS_DEFAULTS };
  return parsePrivateAppsSettings(await readDurableSetting(id, PRIVATE_APPS_KEY).catch(() => null));
}

export async function writePrivateAppsSettings(value: PrivateAppsSettings, updatedBy?: string): Promise<boolean> {
  const id = await systemTenant();
  if (!id) return false;
  await writeDurableSetting(id, PRIVATE_APPS_KEY, JSON.stringify(parsePrivateAppsSettings(JSON.stringify(value))), updatedBy);
  return true;
}

export function parseCustomAppRecord(raw: unknown): CustomAppRecord | null {
  try {
    const v: any = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!v || typeof v !== "object") return null;
    const shop = normalizeShopifyShopDomain(v.shopDomain);
    if (!shop || !["requested", "link_sent", "installed", "revoked"].includes(v.status)) return null;
    return { ...v, shopDomain: shop } as CustomAppRecord;
  } catch {
    return null;
  }
}

export async function readCustomAppRecord(tenantId: string): Promise<CustomAppRecord | null> {
  return parseCustomAppRecord(await readDurableSetting(tenantId, CUSTOM_APP_KEY));
}

export async function writeCustomAppRecord(tenantId: string, record: CustomAppRecord, updatedBy?: string): Promise<void> {
  await writeDurableSetting(tenantId, CUSTOM_APP_KEY, JSON.stringify(record), updatedBy);
}

/** The record without its secret: what any API answers. */
export function publicCustomAppRecord(r: CustomAppRecord | null): Omit<CustomAppRecord, "clientSecretEnc"> | null {
  if (!r) return null;
  const { clientSecretEnc: _s, ...rest } = r;
  return rest;
}

/** Every workspace's record (console list, lookups). One key, a handful of rows. */
export async function listCustomAppRecords(): Promise<Array<{ tenantId: string; record: CustomAppRecord }>> {
  const rows: any[] = await withCrossTenantAccess(() => (prisma as any).tenantSetting.findMany({
    where: { key: CUSTOM_APP_KEY },
    select: { tenantId: true, value: true },
  })) as any[];
  return rows
    .map((r) => ({ tenantId: r.tenantId as string, record: parseCustomAppRecord(r.value) }))
    .filter((r): r is { tenantId: string; record: CustomAppRecord } => !!r.record);
}

/** An app that may sign or be signed for: a link was given (link_sent) or it is installed. */
const LIVE: ReadonlySet<CustomAppStatus> = new Set(["link_sent", "installed"]);

export interface ResolvedApp {
  kind: "custom" | "official";
  clientId: string;
  clientSecret: string;
  /** The workspace the custom app was made for (custom only). */
  tenantId?: string;
}

function officialApp(): ResolvedApp {
  return { kind: "official", clientId: process.env.SHOPIFY_API_KEY || "", clientSecret: process.env.SHOPIFY_API_SECRET || "" };
}

function secretOf(r: CustomAppRecord): string {
  try {
    return r.clientSecretEnc ? String(decryptCredentials(r.clientSecretEnc).clientSecret ?? "") : "";
  } catch {
    return "";
  }
}

/** The custom app made for this shop, when it may be used; null otherwise. */
export async function customAppForShop(shopDomain: unknown, list?: Array<{ tenantId: string; record: CustomAppRecord }>): Promise<ResolvedApp | null> {
  const shop = normalizeShopifyShopDomain(shopDomain);
  if (!shop) return null;
  const hit = (list ?? (await listCustomAppRecords().catch(() => []))).find((x) => x.record.shopDomain === shop && LIVE.has(x.record.status) && x.record.clientId);
  if (!hit) return null;
  const clientSecret = secretOf(hit.record);
  return clientSecret ? { kind: "custom", clientId: hit.record.clientId!, clientSecret, tenantId: hit.tenantId } : null;
}

/** By client id (a token refresh, an OAuth state). */
export async function customAppByClientId(clientId: unknown): Promise<ResolvedApp | null> {
  const id = String(clientId ?? "");
  if (!id) return null;
  const hit = (await listCustomAppRecords().catch(() => [])).find((x) => x.record.clientId === id && LIVE.has(x.record.status));
  if (!hit) return null;
  const clientSecret = secretOf(hit.record);
  return clientSecret ? { kind: "custom", clientId: id, clientSecret, tenantId: hit.tenantId } : null;
}

/** The app that serves this shop: its custom app when there is one, else the official app. */
export async function appForShop(shopDomain: unknown): Promise<ResolvedApp> {
  return (await customAppForShop(shopDomain)) ?? officialApp();
}

/** The app with this client id: the official app's, a custom app's, or null for an unknown one. */
export async function appForClientId(clientId: unknown): Promise<ResolvedApp | null> {
  const official = officialApp();
  if (!clientId || String(clientId) === official.clientId) return official;
  return customAppByClientId(clientId);
}

/**
 * The secrets a signed request for this shop may carry: its custom app's (when it has one) and the
 * official app's. Never a secret of an app we do not know; empty secrets are dropped.
 */
export async function signingSecretsForShop(shopDomain: unknown): Promise<string[]> {
  const custom = await customAppForShop(shopDomain);
  return [custom?.clientSecret, officialApp().clientSecret].filter((s): s is string => !!s);
}

/** Encrypt a pasted secret for the record. */
export function sealClientSecret(secret: string): string {
  return encryptCredentials({ clientSecret: secret });
}

/** An install link Shopify generated: https on admin.shopify.com only. */
export function validInstallLink(raw: unknown): string | null {
  try {
    const u = new URL(String(raw ?? "").trim());
    return u.protocol === "https:" && u.hostname.toLowerCase() === "admin.shopify.com" ? u.toString() : null;
  } catch {
    return null;
  }
}

// ─── Signatures, resolved by shop ────────────────────────────


/** The candidate apps for a signed request about this shop: its custom app first, then the official app. */
export async function candidateAppsForShop(shopDomain: unknown): Promise<ResolvedApp[]> {
  const custom = await customAppForShop(shopDomain);
  return [custom, officialApp()].filter((a): a is ResolvedApp => !!a && !!a.clientSecret);
}

/** Shopify's app launch (the install entry): verified with the shop's app, else the official one. */
export async function verifyAppEntryForShop(query: Record<string, unknown>): Promise<({ ok: true; shop: string; app: ResolvedApp }) | ({ ok: false; reason: string })> {
  const rawShop = Array.isArray(query.shop) ? query.shop[0] : query.shop;
  let last: { ok: false; reason: string } = { ok: false, reason: "not_configured" };
  for (const app of await candidateAppsForShop(rawShop)) {
    const r: any = verifyAppEntryHmac(query, app.clientSecret);
    if (r.ok) return { ok: true, shop: r.shop, app };
    last = { ok: false, reason: r.reason };
    // A missing or malformed shop/hmac/timestamp is the same for every app: no second try.
    if (r.reason !== "hmac_invalid") break;
  }
  return last;
}

/** The OAuth callback: verified with the shop's app, else the official one. */
export async function verifyOAuthCallbackForShop(query: Record<string, unknown>): Promise<({ ok: true; shop: string; app: ResolvedApp }) | ({ ok: false; reason: string })> {
  const rawShop = Array.isArray(query.shop) ? query.shop[0] : query.shop;
  let last: { ok: false; reason: string } = { ok: false, reason: "not_configured" };
  for (const app of await candidateAppsForShop(rawShop)) {
    const r: any = verifyOAuthCallbackHmac(query, app.clientSecret);
    if (r.ok) return { ok: true, shop: r.shop, app };
    last = { ok: false, reason: r.reason };
    if (r.reason !== "hmac_invalid") break;
  }
  return last;
}

/** A webhook delivery for this shop: true when one of its KNOWN apps' secrets signed it. */
export async function verifyWebhookForShop(raw: Buffer | undefined, hmac: string | undefined | null, shopDomain: unknown): Promise<boolean> {
  for (const secret of await signingSecretsForShop(shopDomain)) {
    if (verifyShopifyWebhookHmac(raw, hmac ?? undefined, secret)) return true;
  }
  return false;
}
