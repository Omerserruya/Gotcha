/**
 * Mobile push to iOS, straight to Apple (APNs, HTTP/2 + token auth).
 *
 * Why not through FCM like Android: the app's Capacitor push plugin hands iOS
 * a raw APNs device token (hex), not an FCM registration token, and turning it
 * into one would mean the Firebase iOS SDK - a new dependency. So iOS devices
 * (PushDevice.provider "apns") are sent here, with Node built-ins only:
 * `http2` to Apple and an ES256 provider JWT signed with `crypto`.
 *
 *   POST https://api.push.apple.com/3/device/<token>          (production)
 *   POST https://api.sandbox.push.apple.com/3/device/<token>  (sandbox)
 *
 * The provider JWT ({ iss: team id, iat }, header kid = key id) is reused for
 * about 50 minutes: Apple refuses one older than 60 minutes, and answers
 * TooManyProviderTokenUpdates to one refreshed more often than every 20.
 *
 * Config: APNS_KEY_ID, APNS_TEAM_ID, APNS_PRIVATE_KEY (the .p8 contents,
 * escaped "\\n" accepted), APNS_BUNDLE_ID (default il.co.gotcha.app, the
 * apns-topic), APNS_ENV = sandbox | production (default production). Missing
 * key id, team id or key means "not configured", exactly as for FCM.
 *
 * A token Apple calls dead (410 Unregistered, 400 BadDeviceToken) is the
 * caller's to delete; every other failure keeps it.
 */
import * as http2 from "http2";
import { sign as cryptoSign } from "crypto";

export interface ApnsConfig {
  keyId: string;
  teamId: string;
  privateKey: string;
  bundleId: string;
  host: string;
}

export const APNS_HOSTS = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
} as const;

export function apnsConfig(env: NodeJS.ProcessEnv = process.env): ApnsConfig | null {
  const keyId = (env.APNS_KEY_ID ?? "").trim();
  const teamId = (env.APNS_TEAM_ID ?? "").trim();
  const privateKey = (env.APNS_PRIVATE_KEY ?? "").replace(/\\n/g, "\n").trim();
  if (!keyId || !teamId || !privateKey) return null;
  const bundleId = (env.APNS_BUNDLE_ID ?? "").trim() || "il.co.gotcha.app";
  const host = (env.APNS_ENV ?? "").trim().toLowerCase() === "sandbox" ? APNS_HOSTS.sandbox : APNS_HOSTS.production;
  return { keyId, teamId, privateKey, bundleId, host };
}

/** Reuse window for the provider token: inside Apple's 20-60 minute band. */
export const APNS_JWT_TTL_MS = 50 * 60_000;

let cachedJwt: { jwt: string; issuedAt: number; keyId: string; teamId: string } | null = null;
const sessions = new Map<string, http2.ClientHttp2Session>();

/** Test seam: forget the provider token and close any open HTTP/2 session. */
export function resetApnsState(): void {
  cachedJwt = null;
  for (const s of sessions.values()) { try { s.close(); } catch { /* ignore */ } }
  sessions.clear();
}

const b64url = (v: string | Buffer) => Buffer.from(v).toString("base64url");

/** The ES256 provider token, signed now. ieee-p1363 = the raw r||s JWS wants, not DER. */
export function signApnsJwt(cfg: ApnsConfig, nowSec: number = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: "ES256", kid: cfg.keyId }));
  const claims = b64url(JSON.stringify({ iss: cfg.teamId, iat: nowSec }));
  const sig = cryptoSign("sha256", Buffer.from(`${header}.${claims}`), { key: cfg.privateKey, dsaEncoding: "ieee-p1363" });
  return `${header}.${claims}.${b64url(sig)}`;
}

export function apnsJwt(cfg: ApnsConfig, now: number = Date.now()): string {
  if (cachedJwt && cachedJwt.keyId === cfg.keyId && cachedJwt.teamId === cfg.teamId && now - cachedJwt.issuedAt < APNS_JWT_TTL_MS) {
    return cachedJwt.jwt;
  }
  const jwt = signApnsJwt(cfg, Math.floor(now / 1000));
  cachedJwt = { jwt, issuedAt: now, keyId: cfg.keyId, teamId: cfg.teamId };
  return jwt;
}

/** apns-collapse-id may be at most 64 bytes; cut on a byte budget, never mid-character. */
export function collapseId(id: string): string {
  let out = "";
  for (const ch of id) {
    if (Buffer.byteLength(out + ch) > 64) break;
    out += ch;
  }
  return out;
}

export function buildApnsRequest(cfg: ApnsConfig, opts: { token: string; title: string; body: string; link?: string; conversationId?: string | null; jwt: string }) {
  const { token, title, body, link, conversationId, jwt } = opts;
  const headers: Record<string, string> = {
    ":method": "POST",
    ":path": `/3/device/${token}`,
    authorization: `bearer ${jwt}`,
    "apns-topic": cfg.bundleId,
    "apns-push-type": "alert",
    "apns-priority": "10",
    "content-type": "application/json",
  };
  if (conversationId) headers["apns-collapse-id"] = collapseId(conversationId);
  const payload = {
    aps: { alert: { title, body }, sound: "default", ...(conversationId ? { "thread-id": conversationId } : {}) },
    ...(link ? { link } : {}),
  };
  return { headers, payload };
}

/** True when Apple's answer means this device token will never deliver again. */
export function isDeadApnsToken(status: number, reason: string | undefined): boolean {
  return status === 410 || (status === 400 && reason === "BadDeviceToken");
}

function session(host: string): http2.ClientHttp2Session {
  const open = sessions.get(host);
  if (open && !open.closed && !open.destroyed) return open;
  const s = http2.connect(host);
  // A dropped connection is reopened on the next send, never reused.
  const forget = () => { if (sessions.get(host) === s) sessions.delete(host); };
  s.on("error", forget);
  s.on("close", forget);
  s.on("goaway", forget);
  // Do not keep the process alive for an idle push connection.
  s.unref?.();
  sessions.set(host, s);
  return s;
}

function post(host: string, headers: Record<string, string>, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let req: http2.ClientHttp2Stream;
    try {
      req = session(host).request(headers);
    } catch (err) {
      reject(err);
      return;
    }
    let status = 0;
    let data = "";
    req.setEncoding("utf8");
    req.setTimeout?.(10_000, () => req.close(http2.constants.NGHTTP2_CANCEL));
    req.on("response", (h) => { status = Number(h[":status"] ?? 0); });
    req.on("data", (chunk: string) => { data += chunk; });
    req.on("end", () => resolve({ status, body: data }));
    req.on("error", reject);
    req.end(body);
  });
}

export type ApnsResult = { ok: true } | { ok: false; status: number; reason?: string; dead: boolean };

export async function sendApns(cfg: ApnsConfig, opts: { token: string; title: string; body: string; link?: string; conversationId?: string | null }): Promise<ApnsResult> {
  const attempt = async () => {
    const { headers, payload } = buildApnsRequest(cfg, { ...opts, jwt: apnsJwt(cfg) });
    return post(cfg.host, headers, JSON.stringify(payload));
  };
  let res = await attempt();
  let reason = reasonOf(res.body);
  // Apple stopped accepting our provider token before our own window ran out:
  // sign a fresh one once.
  if (res.status === 403 && (reason === "ExpiredProviderToken" || reason === "InvalidProviderToken")) {
    cachedJwt = null;
    res = await attempt();
    reason = reasonOf(res.body);
  }
  if (res.status === 200) return { ok: true };
  return { ok: false, status: res.status, reason, dead: isDeadApnsToken(res.status, reason) };
}

function reasonOf(body: string): string | undefined {
  try {
    const r = JSON.parse(body)?.reason;
    return typeof r === "string" ? r : undefined;
  } catch {
    return undefined;
  }
}
