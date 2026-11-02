/**
 * Opting in to WhatsApp alerts with a one-time code (2026-11-02).
 *
 * Without it any account could point GOTCHA's number at a stranger's phone.
 * The number is stored, and whatsapp switched on, only when the code sent to
 * that number comes back. The code lives hashed in Redis for 10 minutes, five
 * tries; a resend waits a minute and at most five go out an hour.
 */
import crypto from "crypto";
import { prisma, getRedis, getOutboundAdapter, normalizeWhatsappPhone } from "@chatcenter/shared";
import { getPlatformWhatsAppSender, VERIFICATION_TEMPLATE_NAME, verificationComponents, localeForRecipient } from "./platform-whatsapp";

export const CODE_TTL_S = 600;
const MAX_TRIES = 5;
const RESEND_AFTER_S = 60;
const MAX_PER_HOUR = 5;

const codeKey = (userId: string) => `notify:wa-verify:${userId}`;
const lastKey = (userId: string) => `notify:wa-verify:last:${userId}`;
const hourKey = (userId: string) => `notify:wa-verify:hour:${userId}`;
const hashOf = (userId: string, code: string) => crypto.createHash("sha256").update(`${userId}:${code}`).digest("hex");

export type VerifyRefusal = "whatsapp_phone_invalid" | "whatsapp_unavailable" | "whatsapp_rate_limited" | "whatsapp_send_failed";
export type ConfirmRefusal = "whatsapp_phone_invalid" | "whatsapp_code_invalid" | "whatsapp_code_expired";

export async function startVerification(me: { userId: string; tenantId: string }, rawPhone: unknown, random: () => string = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, "0")):
  Promise<{ ok: true; expiresInSeconds: number } | { ok: false; code: VerifyRefusal }> {
  const phone = normalizeWhatsappPhone(rawPhone);
  if (!phone) return { ok: false, code: "whatsapp_phone_invalid" };
  const sender = getPlatformWhatsAppSender();
  if (!sender) return { ok: false, code: "whatsapp_unavailable" };
  const redis = getRedis();
  if ((await redis.set(lastKey(me.userId), "1", "EX", RESEND_AFTER_S, "NX")) !== "OK") return { ok: false, code: "whatsapp_rate_limited" };
  const sentThisHour = await redis.incr(hourKey(me.userId));
  if (sentThisHour === 1) await redis.expire(hourKey(me.userId), 3600);
  if (sentThisHour > MAX_PER_HOUR) return { ok: false, code: "whatsapp_rate_limited" };
  const code = random();
  await redis.set(codeKey(me.userId), JSON.stringify({ phone, hash: hashOf(me.userId, code), tries: 0 }), "EX", CODE_TTL_S);
  const adapter = getOutboundAdapter("WHATSAPP") as any;
  try {
    const locale = await localeForRecipient(me.tenantId, me.userId);
    await adapter.sendTemplateMessage({ accessToken: sender.accessToken }, sender.externalId, phone.slice(1), VERIFICATION_TEMPLATE_NAME, locale, verificationComponents(code));
  } catch (err: any) {
    await redis.del(codeKey(me.userId));
    console.warn(`[notifications] verification code not sent user=${me.userId}:`, err?.message);
    return { ok: false, code: "whatsapp_send_failed" };
  }
  return { ok: true, expiresInSeconds: CODE_TTL_S };
}

export async function confirmVerification(me: { userId: string; tenantId: string }, rawPhone: unknown, rawCode: unknown):
  Promise<{ ok: true } | { ok: false; code: ConfirmRefusal }> {
  const phone = normalizeWhatsappPhone(rawPhone);
  if (!phone) return { ok: false, code: "whatsapp_phone_invalid" };
  const code = String(rawCode ?? "").replace(/\D/g, "");
  const redis = getRedis();
  const raw = await redis.get(codeKey(me.userId));
  if (!raw) return { ok: false, code: "whatsapp_code_expired" };
  const rec = JSON.parse(raw) as { phone: string; hash: string; tries: number };
  if (rec.tries >= MAX_TRIES) { await redis.del(codeKey(me.userId)); return { ok: false, code: "whatsapp_code_expired" }; }
  const a = Buffer.from(rec.hash);
  const b = Buffer.from(hashOf(me.userId, code));
  if (rec.phone !== phone || code.length !== 6 || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    await redis.set(codeKey(me.userId), JSON.stringify({ ...rec, tries: rec.tries + 1 }), "KEEPTTL");
    return { ok: false, code: "whatsapp_code_invalid" };
  }
  await redis.del(codeKey(me.userId));
  const data = { whatsappPhone: phone, whatsappOptedInAt: new Date(), whatsapp: true };
  await (prisma as any).userNotificationPreference.upsert({
    where: { userId: me.userId },
    create: { userId: me.userId, tenantId: me.tenantId, inApp: true, email: true, approvals: true, ...data },
    update: data,
  });
  return { ok: true };
}
