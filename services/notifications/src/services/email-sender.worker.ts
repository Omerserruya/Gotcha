/**
 * BullMQ worker that drains the `notifications:email` queue.
 *
 * Per job:
 *   1. Token-bucket rate limit per recipient (10/min). If denied, the job
 *      is requeued with a backoff delay so the queue never spams an inbox.
 *   2. Body is rendered HTML from the dispatcher-provided plain text. The
 *      template (subject/body/link) was already produced by the engine.
 *   3. SMTP send via nodemailer. If SMTP_HOST is unset we log-and-skip so
 *      dev/test environments don't blow up.
 *
 * Mirrors the SMTP transport pattern already used in
 *   services/auth/src/services/notification.service.ts
 * - same env vars (SMTP_HOST/PORT/USER/PASS/FROM), same lazy singleton
 * transporter, same stub fallback.
 */

import type { Job, Worker } from "bullmq";
import nodemailer, { type Transporter } from "nodemailer";
import { prisma, getRedis, createWorker,
  resolveAppPublicUrl,
  legalConsentHtml,
  withLegalConsentText,
  type EmailJobData,
} from "@chatcenter/shared";
import { NOTIFICATIONS_EMAIL_QUEUE_NAME } from "./queues";

// The shape is declared in shared now that billing also fills this queue.
// Re-exported so existing importers of this module keep working.
export type { EmailJobData };

let _transporter: Transporter | null = null;
let _worker: Worker<EmailJobData> | null = null;

function getTransporter(): Transporter {
  if (_transporter) return _transporter;
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || "587", 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) {
    // Dev/test stub. The auth service uses the same fallback so we stay consistent.
    console.warn("[notifications.email] SMTP not configured - using log-only stub");
    _transporter = {
      sendMail: async (m: any) => {
        console.log(`[notifications.email STUB] to=${m.to} subject="${m.subject}"`);
        return { messageId: `stub-${Date.now()}` };
      },
    } as any;
    return _transporter!;
  }
  _transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
  return _transporter;
}

// Token bucket: 10 emails/min per user. Implemented as INCR + EXPIRE on a
// fixed-window key. Simple and correct enough for notification spam control;
// if a worker reboots mid-window the worst case is a small refund.
const EMAIL_RATE_MAX = 10;
const EMAIL_RATE_WINDOW_SEC = 60;

async function checkRateLimit(userId: string): Promise<{ allowed: boolean; retryAfterMs: number }> {
  try {
    const redis = getRedis();
    const key = `notif:rl:email:${userId}`;
    const count = await (redis as any).incr(key);
    if (count === 1) await (redis as any).expire(key, EMAIL_RATE_WINDOW_SEC);
    if (count > EMAIL_RATE_MAX) {
      const ttl = await (redis as any).ttl(key);
      return { allowed: false, retryAfterMs: Math.max(1000, ttl * 1000) };
    }
    return { allowed: true, retryAfterMs: 0 };
  } catch (err: any) {
    // Fail open - better to over-deliver than to drop on a Redis hiccup.
    console.warn("[notifications.email] rate-limit redis failed:", err?.message);
    return { allowed: true, retryAfterMs: 0 };
  }
}

function renderHtml(body: string, link?: string): string {
  // Absolutize relative dashboard paths - mail clients have no base URL,
  // so a bare "/approvals" becomes "http://approvals/" when clicked.
  const baseUrl = resolveAppPublicUrl(process.env);
  const fullLink = link && !/^https?:\/\//i.test(link) ? `${baseUrl}${link}` : link;
  const linkBlock = fullLink
    ? `<p style="margin-top:24px"><a href="${fullLink}" style="background:#7c5cfc;color:#fff;padding:8px 16px;border-radius:6px;text-decoration:none">Open in dashboard</a></p>`
    : "";
  // The same consent line the branded template carries in its footer, so a
  // notification is not the one email that omits it.
  const legalBlock =
    `<p style="margin:28px 0 0;padding-top:12px;border-top:1px solid #eee;` +
    `font-size:11px;line-height:18px;color:#8a8a90">${legalConsentHtml()}</p>`;
  return (
    `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111;line-height:1.5;max-width:560px">` +
    `<pre style="white-space:pre-wrap;font-family:inherit;margin:0">${body}</pre>` +
    linkBlock +
    legalBlock +
    `</div>`
  );
}

async function logSend(data: EmailJobData, status: "sent" | "failed", error?: string) {
  try {
    await (prisma as any).notificationLog.create({
      data: {
        tenantId: data.tenantId,
        channel: "email",
        type: data.eventType,
        recipient: data.to,
        subject: data.subject,
        body: data.body,
        status,
        error,
        metadata: { eventId: data.eventId, userId: data.userId, priority: data.priority },
        sentAt: status === "sent" ? new Date() : undefined,
      },
    });
  } catch (err: any) {
    console.warn("[notifications.email] logSend failed:", err?.message);
  }
}

export function startNotificationsEmailWorker(): Worker<EmailJobData> {
  if (_worker) return _worker;
  _worker = createWorker<EmailJobData>(
    NOTIFICATIONS_EMAIL_QUEUE_NAME,
    async (job: Job<EmailJobData>) => {
      const d = job.data;
      if (!d?.to) return;

      // A receipt is a legal record, not a notification. Holding one back
      // because the same address was mailed a moment ago would be the wrong
      // trade: a duplicate is an annoyance, a missing proof of payment is not.
      const rl = d.bypassRateLimit ? { allowed: true as const, retryAfterMs: 0 } : await checkRateLimit(d.userId);
      if (!rl.allowed) {
        // Re-enqueue with delay so we don't burn attempts. BullMQ counts a
        // throw as an attempt - adding a delayed copy keeps the original
        // attempt counter intact.
        const { getNotificationsEmailQueue, DEFAULT_NOTIF_JOB_OPTS } = await import("./queues");
        await getNotificationsEmailQueue().add("send-email", d, {
          ...DEFAULT_NOTIF_JOB_OPTS,
          delay: rl.retryAfterMs,
        });
        return;
      }

      const transporter = getTransporter();
      try {
        await transporter.sendMail({
          from: process.env.SMTP_FROM || process.env.SMTP_USER,
          to: d.to,
          subject: d.subject,
          // text/plain gets the consent line too: a client that renders only
          // the plain part would otherwise show an email with no terms on it.
          text: withLegalConsentText(d.body),
          // A pre-rendered body is sent as-is. renderHtml wraps plain text in a
          // <pre>, which would turn a designed email into a screenshot of one.
          html: d.html || renderHtml(d.body, d.link),
        });
        await logSend(d, "sent");
      } catch (err: any) {
        await logSend(d, "failed", err?.message?.slice(0, 500));
        throw err; // BullMQ retry/backoff
      }
    },
    { concurrency: 5 },
  );
  console.log(`[notifications] email worker started (queue=${NOTIFICATIONS_EMAIL_QUEUE_NAME})`);
  return _worker;
}

export async function stopNotificationsEmailWorker(): Promise<void> {
  if (!_worker) return;
  await _worker.close();
  _worker = null;
}
