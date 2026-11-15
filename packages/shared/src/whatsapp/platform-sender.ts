/**
 * GOTCHA's own WhatsApp sending number (the platform alerts number): which one
 * is in effect, for every service that sends from it or receives on it.
 * (2026-11-15, PLAN: release-next-kit/platform-whatsapp/PLAN.md section 2.)
 *
 * Precedence:
 *   1. The console's row (platform_whatsapp_senders, id "platform") when it is
 *      CONNECTED or PENDING_WEBHOOK. PENDING_WEBHOOK still sends; only inbound
 *      may be missing.
 *   2. Otherwise the env pair PLATFORM_WHATSAPP_PHONE_NUMBER_ID +
 *      PLATFORM_WHATSAPP_ACCESS_TOKEN, when both are set.
 *   3. Otherwise null. Null is a real answer: a caller skips WhatsApp and says
 *      so. It never borrows a tenant's number.
 *
 * Inbound recognises BOTH the row's id (any status but DISCONNECTED) and the
 * env id, so an approval tapped on a message sent before a switch still lands.
 *
 * The row is written only by auth's /api/system/platform-whatsapp routes,
 * which call bumpPlatformSenderVersion() after each write. Reads are cached
 * per process for 30 seconds or until the Redis version moves.
 *
 * A missing table (an image ahead of its migration) reads as "no row", so the
 * env fallback keeps sending.
 */
import { prisma } from "../lib/prisma";
import { getRedis } from "../lib/redis";
import { decryptCredentials } from "../lib/encryption";

export const PLATFORM_SENDER_ID = "platform";
export const PLATFORM_SENDER_VERSION_KEY = "platform_whatsapp:version";
const CACHE_MS = 30_000;

export interface PlatformSenderRow {
  id: string;
  status: "CONNECTED" | "PENDING_WEBHOOK" | "TOKEN_INVALID" | "DISCONNECTED";
  wabaId: string | null;
  phoneNumberId: string | null;
  credentials: string | null;
  alertsEnabled: unknown;
  [k: string]: unknown;
}

export interface ResolvedPlatformSender {
  /** The phone number id Meta sends from. */
  externalId: string;
  accessToken: string;
  wabaId: string | null;
  source: "db" | "env";
}

let cache: { at: number; version: string | null; row: PlatformSenderRow | null } | null = null;
let missingTableLogged = false;

/** Test seam and post-write reset. */
export function clearPlatformSenderCache(): void {
  cache = null;
}

/**
 * The shared Redis client queues commands forever while disconnected
 * (maxRetriesPerRequest: null), so a send must never wait on it: when Redis is
 * not ready, or slower than 300ms, the version is unknown and the 30s cache
 * alone decides.
 */
async function readVersion(): Promise<string | null> {
  try {
    const redis = getRedis();
    if ((redis as any).status !== "ready") return null;
    return await Promise.race([
      redis.get(PLATFORM_SENDER_VERSION_KEY),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 300).unref?.()),
    ]);
  } catch {
    return null;
  }
}

/** After any write to the row: every process re-reads it on its next call. */
export async function bumpPlatformSenderVersion(): Promise<void> {
  cache = null;
  try {
    const redis = getRedis();
    if ((redis as any).status !== "ready") throw new Error(`redis ${String((redis as any).status)}`);
    await Promise.race([
      redis.incr(PLATFORM_SENDER_VERSION_KEY),
      new Promise((_r, reject) => setTimeout(() => reject(new Error("redis timeout")), 1000).unref?.()),
    ]);
  } catch (err: any) {
    console.warn(`[platform-sender] version bump failed (other processes see the change within 30s): ${err?.message}`);
  }
}

/** The console's row, or null (none, or the table not migrated yet). */
export async function readPlatformSenderRow(now = Date.now()): Promise<PlatformSenderRow | null> {
  const version = await readVersion();
  if (cache && now - cache.at < CACHE_MS && cache.version === version) return cache.row;
  let row: PlatformSenderRow | null = null;
  try {
    row = (await (prisma as any).platformWhatsAppSender.findUnique({ where: { id: PLATFORM_SENDER_ID } })) ?? null;
  } catch (err: any) {
    if (!missingTableLogged) {
      missingTableLogged = true;
      console.warn(`[platform-sender] platform_whatsapp_senders unreadable, using env only: ${err?.code ?? ""} ${err?.message ?? err}`);
    }
    row = null;
  }
  cache = { at: now, version, row };
  return row;
}

/** The env pair, or null when either half is missing. */
export function envPlatformSender(env: NodeJS.ProcessEnv = process.env): { externalId: string; accessToken: string } | null {
  const externalId = (env.PLATFORM_WHATSAPP_PHONE_NUMBER_ID ?? "").trim();
  const accessToken = (env.PLATFORM_WHATSAPP_ACCESS_TOKEN ?? "").trim();
  if (!externalId || !accessToken) return null;
  return { externalId, accessToken };
}

/** A row that may send: CONNECTED or PENDING_WEBHOOK, with an id and a token. */
export function rowCanSend(row: PlatformSenderRow | null): boolean {
  return !!row && (row.status === "CONNECTED" || row.status === "PENDING_WEBHOOK") && !!row.phoneNumberId && !!row.credentials;
}

function rowToken(row: PlatformSenderRow): string | null {
  try {
    const c = decryptCredentials(String(row.credentials));
    return typeof c?.accessToken === "string" && c.accessToken ? c.accessToken : null;
  } catch (err: any) {
    console.warn(`[platform-sender] credentials unreadable: ${err?.message}`);
    return null;
  }
}

/** The sender in effect, by the precedence above. */
export async function resolvePlatformWhatsAppSender(env: NodeJS.ProcessEnv = process.env): Promise<ResolvedPlatformSender | null> {
  const row = await readPlatformSenderRow();
  if (rowCanSend(row)) {
    const accessToken = rowToken(row!);
    if (accessToken) return { externalId: String(row!.phoneNumberId), accessToken, wabaId: row!.wabaId ?? null, source: "db" };
  }
  const e = envPlatformSender(env);
  return e ? { ...e, wabaId: null, source: "env" } : null;
}

/** Inbound: is this phone_number_id GOTCHA's own number (the row's, unless DISCONNECTED, or the env's)? */
export async function isPlatformPhoneNumberId(id: string | null | undefined, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const v = String(id ?? "").trim();
  if (!v) return false;
  const row = await readPlatformSenderRow();
  if (row && row.status !== "DISCONNECTED" && row.phoneNumberId === v) return true;
  return envPlatformSender(env)?.externalId === v;
}

/** Template webhooks: is this WABA the platform number's (any status but DISCONNECTED)? */
export async function isPlatformWaba(wabaId: string | null | undefined): Promise<boolean> {
  const v = String(wabaId ?? "").trim();
  if (!v) return false;
  const row = await readPlatformSenderRow();
  return !!row && row.status !== "DISCONNECTED" && row.wabaId === v;
}

/** Meta's "this token no longer works": code 190 (or 102), subcodes 463/467 included. */
export function isMetaTokenError(err: any): boolean {
  // An axios error (response.data.error), the adapter's ChannelSendError
  // (provider.code / provider.subcode) or a MetaApiError (code / subcode).
  const e = err?.response?.data?.error ?? err?.provider ?? err;
  const code = Number(e?.code ?? err?.code);
  const sub = Number(e?.error_subcode ?? e?.subcode ?? err?.subcode);
  return code === 190 || code === 102 || sub === 463 || sub === 467;
}

/**
 * A send from the console's number answered with a dead token: the row
 * becomes TOKEN_INVALID (sends fall back to env or stop). Only a db-sourced
 * send may call this; an env token failing says nothing about the row.
 * Returns whether the row was marked.
 */
export async function markPlatformTokenInvalid(err: any): Promise<boolean> {
  if (!isMetaTokenError(err)) return false;
  const msg = String(err?.response?.data?.error?.message ?? err?.provider?.message ?? err?.message ?? "the access token was refused").slice(0, 300);
  try {
    const r = await (prisma as any).platformWhatsAppSender.updateMany({
      where: { id: PLATFORM_SENDER_ID, status: { in: ["CONNECTED", "PENDING_WEBHOOK"] } },
      data: { status: "TOKEN_INVALID", lastError: `[TOKEN_INVALID] ${msg}` },
    });
    await bumpPlatformSenderVersion();
    return (r?.count ?? 0) > 0;
  } catch (e: any) {
    console.warn(`[platform-sender] could not mark TOKEN_INVALID: ${e?.message}`);
    return false;
  }
}

function enabledMap(v: unknown): Record<string, boolean> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, boolean>) : {};
}

/**
 * May the platform number send this template (row key) now?
 *
 *   - "db" source: the template is APPROVED in both he and en, and its
 *     governing alert is switched on (verification has no switch). A stale
 *     switch can never send.
 *   - "env" source: as before the console existed, every template counts.
 */
export async function platformTemplateSendable(
  templateKey: string,
  governedBy: string | null,
  source: "db" | "env",
): Promise<{ ok: true } | { ok: false; reason: "alert_disabled" | "template_not_approved" }> {
  if (source === "env") return { ok: true };
  const row = await readPlatformSenderRow();
  if (governedBy && enabledMap(row?.alertsEnabled)[governedBy] !== true) return { ok: false, reason: "alert_disabled" };
  let approved = 0;
  try {
    approved = await (prisma as any).platformWhatsAppTemplate.count({
      where: { eventType: templateKey, language: { in: ["he", "en"] }, status: "APPROVED" },
    });
  } catch {
    approved = 0;
  }
  return approved >= 2 ? { ok: true } : { ok: false, reason: "template_not_approved" };
}
