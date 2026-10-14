/**
 * List-Unsubscribe for marketing email (RFC 2369 + RFC 8058, 2026-10-14).
 *
 * Every marketing email (an automation run marked marketing, an email
 * broadcast) carries:
 *   List-Unsubscribe: <mailto:THE_SENDING_MAILBOX?subject=unsubscribe&body=unsubscribe>, <https://.../api/contacts/unsubscribe/TOKEN>
 *   List-Unsubscribe-Post: List-Unsubscribe=One-Click
 *
 * The mailto lands in the mailbox we ingest; its body is an exact opt-out
 * keyword, so the existing reply handling opts the customer out. The https
 * link is the one-click: a POST to it opts out at once (RFC 8058), a GET only
 * shows a confirm page (mail scanners fetch links). The https part, and with
 * it the one-click header, is left out when no public origin is configured.
 *
 * The token names the tenant, the contact and the channel, signed with a key
 * derived from CHANNEL_ENCRYPTION_KEY (its own HKDF info, like signed media
 * links). It does not expire: an unsubscribe link has to keep working.
 *
 * No imports but crypto: services deep-import this file.
 */
import crypto from "crypto";

const HKDF_INFO = "gotcha-list-unsubscribe-v1";
const VERSION = "u1";

export interface UnsubscribeSubject {
  tenantId: string;
  contactId: string;
  channel: string;
}

function key(): Buffer | null {
  const raw = process.env.CHANNEL_ENCRYPTION_KEY;
  if (!raw) return null;
  return Buffer.from(crypto.hkdfSync("sha256", Buffer.from(raw, "utf8"), Buffer.alloc(0), HKDF_INFO, 32));
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url").toString("utf8");
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const CHANNEL = /^[A-Z_]{2,32}$/;

/** The signed token, or null without a key or with ids that cannot be carried. */
export function signUnsubscribeToken(s: UnsubscribeSubject): string | null {
  const k = key();
  const channel = String(s.channel ?? "").toUpperCase();
  if (!k || !ID.test(s.tenantId) || !ID.test(s.contactId) || !CHANNEL.test(channel)) return null;
  const payload = `${VERSION}.${s.tenantId}.${s.contactId}.${channel}`;
  const mac = crypto.createHmac("sha256", k).update(payload).digest("base64url");
  return `${b64(payload)}.${mac}`;
}

/** Who the token unsubscribes, or null when it is not one we signed. */
export function verifyUnsubscribeToken(token: unknown): UnsubscribeSubject | null {
  const k = key();
  if (!k || typeof token !== "string" || token.length > 512) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  let payload: string;
  try { payload = unb64(token.slice(0, dot)); } catch { return null; }
  const want = crypto.createHmac("sha256", k).update(payload).digest();
  let got: Buffer;
  try { got = Buffer.from(token.slice(dot + 1), "base64url"); } catch { return null; }
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  const [v, tenantId, contactId, channel] = payload.split(".");
  if (v !== VERSION || !tenantId || !contactId || !channel || !ID.test(tenantId) || !ID.test(contactId) || !CHANNEL.test(channel)) return null;
  return { tenantId, contactId, channel };
}

/** The public origin links are built on, or null when none is configured. */
export function publicOrigin(env: Record<string, string | undefined> = process.env): string | null {
  for (const v of [env.PUBLIC_URL, env.APP_PUBLIC_URL, env.NEXT_PUBLIC_API_URL]) {
    if (!v) continue;
    try {
      const u = new URL(v);
      if (u.protocol === "https:") return u.origin;
    } catch { /* next */ }
  }
  return null;
}

const MAILBOX = /^[^\s<>@,;"]+@[^\s<>@,;"]+\.[^\s<>@,;"]+$/;

/**
 * The header lines for one marketing email ("Name: value" pairs), or [] when
 * there is nothing valid to offer. `mailbox` is the address the email is sent
 * from (its replies are ingested).
 */
export function listUnsubscribeHeaders(input: {
  subject: UnsubscribeSubject;
  mailbox: string | null | undefined;
  origin?: string | null;
}): Array<{ name: string; value: string }> {
  const parts: string[] = [];
  const mailbox = String(input.mailbox ?? "").trim();
  if (MAILBOX.test(mailbox)) parts.push(`<mailto:${mailbox}?subject=unsubscribe&body=unsubscribe>`);
  const origin = input.origin === undefined ? publicOrigin() : input.origin;
  const token = origin ? signUnsubscribeToken(input.subject) : null;
  if (origin && token) parts.push(`<${origin}/api/contacts/unsubscribe/${token}>`);
  if (!parts.length) return [];
  const headers = [{ name: "List-Unsubscribe", value: parts.join(", ") }];
  // One-click only when there is an https link to POST to (RFC 8058 §3.1).
  if (origin && token) headers.push({ name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" });
  return headers;
}
