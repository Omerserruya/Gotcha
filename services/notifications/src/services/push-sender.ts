/**
 * Mobile push: Android through Firebase Cloud Messaging (HTTP v1), iOS
 * straight to Apple (apns-sender.ts). Each PushDevice says which (provider).
 *
 *   POST https://fcm.googleapis.com/v1/projects/{project}/messages:send
 *
 * Authorised with a Google OAuth2 access token obtained from a service
 * account by the JWT-bearer grant. The assertion is signed RS256 with Node's
 * own `crypto` - no google-auth-library (no new dependencies), and nothing
 * here is authentication of OUR users: it is GOTCHA proving itself to Google,
 * the same shape as any outbound API key. The token lives about an hour and is
 * cached until a minute before it expires.
 *
 * Config, all three or the channel is "not configured":
 *   FCM_PROJECT_ID, FCM_CLIENT_EMAIL, FCM_PRIVATE_KEY
 * The private key usually arrives through an env file with its newlines
 * escaped ("\\n"); both forms are accepted. Not configured is a normal state
 * (dev, a self-hosted install without the app), so it is said ONCE per process
 * and every push is then skipped silently.
 *
 * A token FCM says is dead (UNREGISTERED, 404, INVALID_ARGUMENT) is deleted:
 * the app was uninstalled or the token rotated, and it will never deliver
 * again. Every other failure keeps the row - a 5xx or a quota error is
 * Google's bad minute, not the phone's.
 */
import { createSign } from "crypto";
import { prisma } from "@chatcenter/shared";
import type { SystemEvent } from "./event-emitter.service";
import { apnsConfig, sendApns, resetApnsState } from "./apns-sender";

export interface FcmConfig { projectId: string; clientEmail: string; privateKey: string }

export function fcmConfig(env: NodeJS.ProcessEnv = process.env): FcmConfig | null {
  const projectId = (env.FCM_PROJECT_ID ?? "").trim();
  const clientEmail = (env.FCM_CLIENT_EMAIL ?? "").trim();
  const privateKey = (env.FCM_PRIVATE_KEY ?? "").replace(/\\n/g, "\n").trim();
  if (!projectId || !clientEmail || !privateKey) return null;
  return { projectId, clientEmail, privateKey };
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
/** Refresh this long before Google's stated expiry. */
const EXPIRY_MARGIN_MS = 60_000;

let cached: { token: string; expiresAt: number; clientEmail: string } | null = null;

/** Test seam: forget the cached access tokens and the "not configured" lines. */
export function resetPushSenderState(): void {
  cached = null;
  said.clear();
  resetApnsState();
}

const b64url = (v: string | Buffer) => Buffer.from(v).toString("base64url");

/** The signed JWT-bearer assertion for this service account. */
export function signAssertion(cfg: FcmConfig, nowSec: number = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: cfg.clientEmail, scope: SCOPE, aud: TOKEN_URL, iat: nowSec, exp: nowSec + 3600 }));
  const signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(cfg.privateKey);
  return `${header}.${claims}.${b64url(signature)}`;
}

export async function accessToken(cfg: FcmConfig, now: number = Date.now()): Promise<string> {
  if (cached && cached.clientEmail === cfg.clientEmail && cached.expiresAt - EXPIRY_MARGIN_MS > now) return cached.token;
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: signAssertion(cfg, Math.floor(now / 1000)),
    }).toString(),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || typeof json?.access_token !== "string") {
    throw new Error(`FCM auth failed (${res.status}${json?.error ? `: ${json.error}` : ""})`);
  }
  const ttlSec = typeof json.expires_in === "number" ? json.expires_in : 3600;
  cached = { token: json.access_token, expiresAt: now + ttlSec * 1000, clientEmail: cfg.clientEmail };
  return cached.token;
}

/** The conversation an event is about, if any. */
export function conversationOf(event: Pick<SystemEvent, "data" | "metadata">): string | null {
  const id = event.metadata?.conversationId ?? (event.data as any)?.conversationId;
  return typeof id === "string" && id ? id : null;
}

/**
 * Where a tap on the push opens, in the mobile app's routes. The in-app row
 * keeps the web link the template produced (/inbox?c=..., /approvals?id=...);
 * the phone has its own screens, so push carries its own link.
 */
export function mobileLink(event: Pick<SystemEvent, "type" | "data" | "metadata">, webLink?: string): string | undefined {
  if (event.type === "tool.approval_required") return "/m/approvals";
  const conv = conversationOf(event);
  if (conv) return `/m/inbox/${encodeURIComponent(conv)}`;
  return webLink;
}

/**
 * The FCM v1 message. Everything about one conversation shares one collapse
 * id on both platforms, so ten messages from one customer stack as one
 * notification rather than ten. `data` values must be strings in FCM.
 */
export function buildFcmMessage(opts: { token: string; title: string; body: string; link?: string; eventType: string; conversationId?: string | null }) {
  const { token, title, body, link, eventType, conversationId } = opts;
  const data: Record<string, string> = { eventType };
  if (link) data.link = link;
  if (conversationId) data.conversationId = conversationId;
  return {
    message: {
      token,
      notification: { title, body },
      data,
      android: { priority: "HIGH", ...(conversationId ? { collapse_key: conversationId } : {}) },
      apns: {
        headers: conversationId ? { "apns-collapse-id": conversationId } : {},
        payload: { aps: { sound: "default", ...(conversationId ? { "thread-id": conversationId } : {}) } },
      },
    },
  };
}

/** True when FCM's answer means the token itself will never deliver again. */
export function isDeadToken(status: number, json: any): boolean {
  if (status === 404) return true;
  const err = json?.error ?? {};
  if (err.status === "NOT_FOUND" || err.status === "INVALID_ARGUMENT") return true;
  const details: any[] = Array.isArray(err.details) ? err.details : [];
  return details.some((d) => d?.errorCode === "UNREGISTERED" || d?.errorCode === "INVALID_ARGUMENT");
}

export type PushOutcome =
  | { status: "not_configured" }
  | { status: "no_devices" }
  | { status: "sent"; sent: number; failed: number; removed: number; skipped: number };

type Device = { id: string; token: string; platform: string; provider: string };
type Attempt = { ok: true } | { ok: false; error: string; dead: boolean };

/** Said once per process per provider: not configured is a normal state, not an incident. */
const said = new Set<string>();
function sayNotConfigured(provider: "fcm" | "apns") {
  if (said.has(provider)) return;
  said.add(provider);
  console.info(provider === "fcm"
    ? "[notifications.push] FCM is not configured (FCM_PROJECT_ID / FCM_CLIENT_EMAIL / FCM_PRIVATE_KEY); Android push is skipped"
    : "[notifications.push] APNs is not configured (APNS_KEY_ID / APNS_TEAM_ID / APNS_PRIVATE_KEY); iOS push is skipped");
}

async function sendFcm(cfg: FcmConfig, d: Device, msg: { title: string; body: string; link?: string; eventType: string; conversationId: string | null }): Promise<Attempt> {
  const url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(cfg.projectId)}/messages:send`;
  const send = async () => fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${await accessToken(cfg)}`, "Content-Type": "application/json" },
    body: JSON.stringify(buildFcmMessage({ token: d.token, ...msg })),
  });
  let res = await send();
  // A token Google revoked early: fetch a fresh one once.
  if (res.status === 401) { cached = null; res = await send(); }
  if (res.ok) return { ok: true };
  const json: any = await res.json().catch(() => ({}));
  return {
    ok: false,
    error: `FCM ${res.status}${json?.error?.status ? ` ${json.error.status}` : ""}${json?.error?.message ? `: ${json.error.message}` : ""}`,
    dead: isDeadToken(res.status, json),
  };
}

/**
 * Send one notice to every phone this person registered in this tenant, each
 * through its own provider (Android: FCM; iOS: APNs directly, see
 * apns-sender.ts). A device whose provider is not configured is skipped
 * without a row, as is a person with no device. Never throws for a single
 * device; one NotificationLog row per device actually tried, like the email
 * sender's one row per send.
 */
export async function sendPushToUser(opts: {
  user: { id: string; tenantId: string; email?: string | null };
  event: Pick<SystemEvent, "id" | "type" | "data" | "metadata">;
  tpl: { title: string; body: string; link?: string };
  priority?: string;
}): Promise<PushOutcome> {
  const { user, event, tpl } = opts;
  const fcm = fcmConfig();
  const apns = apnsConfig();
  if (!fcm) sayNotConfigured("fcm");
  if (!apns) sayNotConfigured("apns");
  if (!fcm && !apns) return { status: "not_configured" };

  const devices: Device[] = await (prisma as any).pushDevice.findMany({
    where: { tenantId: user.tenantId, userId: user.id },
    select: { id: true, token: true, platform: true, provider: true },
  });
  if (!devices.length) return { status: "no_devices" };

  const conversationId = conversationOf(event);
  const link = mobileLink(event, tpl.link);
  let sent = 0, failed = 0, removed = 0, skipped = 0;
  for (const d of devices) {
    const provider = d.provider === "apns" ? "apns" : "fcm";
    if ((provider === "fcm" && !fcm) || (provider === "apns" && !apns)) { skipped++; continue; }
    let attempt: Attempt;
    try {
      attempt = provider === "apns"
        ? await sendApns(apns!, { token: d.token, title: tpl.title, body: tpl.body, link, conversationId })
            .then((r): Attempt => (r.ok ? r : { ok: false, error: `APNs ${r.status}${r.reason ? ` ${r.reason}` : ""}`, dead: r.dead }))
        : await sendFcm(fcm!, d, { title: tpl.title, body: tpl.body, link, eventType: event.type, conversationId });
    } catch (err: any) {
      attempt = { ok: false, error: err?.message ?? String(err), dead: false };
    }
    let error: string | undefined;
    if (attempt.ok) {
      sent++;
    } else {
      failed++;
      error = attempt.error;
      if (attempt.dead) {
        try {
          await (prisma as any).pushDevice.deleteMany({ where: { id: d.id, token: d.token } });
          removed++;
          error += " (device removed)";
        } catch (err: any) {
          console.warn("[notifications.push] removing a dead device failed:", err?.message);
        }
      }
    }
    try {
      await (prisma as any).notificationLog.create({
        data: {
          tenantId: user.tenantId,
          channel: "push",
          type: event.type,
          recipient: user.email ?? user.id,
          subject: tpl.title,
          body: tpl.body,
          status: attempt.ok ? "sent" : "failed",
          error,
          // Never the token itself: it is a credential to reach that phone.
          metadata: { eventId: event.id, userId: user.id, deviceId: d.id, platform: d.platform, provider, priority: opts.priority },
          sentAt: attempt.ok ? new Date() : undefined,
        },
      });
    } catch (err: any) {
      console.warn("[notifications.push] log failed:", err?.message);
    }
  }
  return { status: "sent", sent, failed, removed, skipped };
}
