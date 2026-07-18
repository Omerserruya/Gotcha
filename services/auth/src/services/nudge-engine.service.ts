/**
 * Onboarding Nudge Engine - a generic, restart-safe, idempotent, tenant-aware,
 * PERSONALIZED lifecycle-nudge scheduler.
 *
 * Design (smallest architecture that satisfies every requirement):
 *  - Source of truth is the `ScheduledNudge` DB row, NOT a Redis job - so a
 *    nudge survives a full Redis flush. (Answers: survive restarts.)
 *  - A repeatable BullMQ sweep (every few minutes) sends the DUE ones. Reuses
 *    the existing shared queue/worker infra. (Answers: infra reuse.)
 *  - Idempotent: unique (tenantId, dedupeKey). Scheduling the same logical nudge
 *    again re-arms the same row; the sweep marks a row SENT exactly once.
 *  - Cancel / reschedule: cancelOnboardingNudges / re-calling schedule.
 *  - Personalized: content is computed at SEND time from the live onboarding
 *    snapshot, so it always reflects where the customer actually is - and if the
 *    reason no longer holds (they already did it), the nudge is SKIPPED, not sent.
 *
 * `kind` keeps it generic so future lifecycle nudges (trial-ending,
 * re-engagement, …) reuse the same table, scheduler, and sweep.
 */

import { Queue } from "bullmq";
import { prisma, createWorker } from "@chatcenter/shared";
import { createSetupLink, sendNudgeEmail, renderBrandEmail, emailParagraph, escapeHtml } from "./notification.service";
import { getOnboardingSnapshot, type OnboardingSnapshot } from "./onboarding-state.service";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const NUDGE_QUEUE_NAME = "lifecycle-nudges";
const ONBOARDING_KIND = "onboarding";
export const ONBOARDING_DEDUPE_KEY = "onboarding_next_step";
const MAX_ATTEMPTS = 5;

// ─── Scheduling ─────────────────────────────────────────────

export type WhenPreset = "30m" | "1h" | "3h" | "tomorrow_morning" | "1d" | "3d" | "1w";
export type WhenInput = WhenPreset | Date | number; // number = ms from now

export function resolveWhen(when: WhenInput): Date {
  if (when instanceof Date) return when;
  if (typeof when === "number") return new Date(Date.now() + when);
  const now = Date.now();
  switch (when) {
    case "30m": return new Date(now + 30 * 60_000);
    case "1h": return new Date(now + 60 * 60_000);
    case "3h": return new Date(now + 3 * 60 * 60_000);
    case "1d": return new Date(now + 24 * 60 * 60_000);
    case "3d": return new Date(now + 3 * 24 * 60 * 60_000);
    case "1w": return new Date(now + 7 * 24 * 60 * 60_000);
    case "tomorrow_morning": {
      const d = new Date(now);
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0); // 09:00 server-local
      return d;
    }
    default: return new Date(now + 24 * 60 * 60_000);
  }
}

/**
 * Schedule (or re-arm) the tenant's onboarding next-step nudge. Idempotent via
 * the unique (tenantId, dedupeKey): each onboarding action pushes it forward
 * rather than piling up duplicates.
 */
export async function scheduleOnboardingNudge(tenantId: string, when: WhenInput = "1d"): Promise<void> {
  const scheduledFor = resolveWhen(when);
  try {
    await prisma.scheduledNudge.upsert({
      where: { tenantId_dedupeKey: { tenantId, dedupeKey: ONBOARDING_DEDUPE_KEY } },
      update: { scheduledFor, status: "PENDING", kind: ONBOARDING_KIND, channel: "email", attempts: 0, lastError: null },
      create: { tenantId, kind: ONBOARDING_KIND, dedupeKey: ONBOARDING_DEDUPE_KEY, scheduledFor, status: "PENDING", channel: "email" },
    });
  } catch (err: any) {
    console.warn("[nudge-engine] scheduleOnboardingNudge failed:", err?.message);
  }
}

/** Cancel the tenant's pending onboarding nudges (e.g. on activation or reset). */
export async function cancelOnboardingNudges(tenantId: string): Promise<void> {
  try {
    await prisma.scheduledNudge.updateMany({
      where: { tenantId, kind: ONBOARDING_KIND, status: "PENDING" },
      data: { status: "CANCELLED" },
    });
  } catch (err: any) {
    console.warn("[nudge-engine] cancelOnboardingNudges failed:", err?.message);
  }
}

// ─── Personalization ────────────────────────────────────────

export interface NudgeContent {
  reason: string;
  subject: string;
  headline: string;
  body: string;
}

/**
 * Compute the personalized nudge for a snapshot, or null when there is nothing
 * honest to say (the customer already advanced past every open step). Priority
 * follows the onboarding order so we always nudge the FIRST unmet milestone.
 * Localized (he/en) so a Hebrew tenant hears the Voice in their own language.
 */
export function contentForSnapshot(s: OnboardingSnapshot, locale: string = "en"): NudgeContent | null {
  const he = locale === "he";
  const company = s.company;
  const employee = s.aiEmployeeName || (he ? "עובד ה-AI שלכם" : "your AI employee");
  const refundGap = s.gaps.find((g) => /refund|החזר/i.test(g));

  if (s.status === "ACTIVE") {
    if (s.channelsConnected === 0) {
      return {
        reason: "active_no_channel",
        subject: he ? `${company}: עובד ה-AI שלכם מחכה להתחיל לעבוד` : `${company}: your AI employee is waiting to start working`,
        headline: he ? "עובד ה-AI שלכם מחכה להתחיל לעבוד" : "Your AI Employee is waiting to start working",
        body: he
          ? `הכול מוכן. חברו את וואטסאפ ו${employee} יתחיל לטפל בשיחות אמיתיות עם לקוחות כבר היום.`
          : `Everything's set up. Connect WhatsApp and ${employee} can start handling real customer conversations today.`,
      };
    }
    return null; // live and reachable - nothing to nudge
  }

  if (!s.discoveryComplete) {
    return {
      reason: "not_started",
      subject: he ? `${company}: ה-AI שלכם מוכן להכיר את העסק` : `${company}: your AI is ready to meet your business`,
      headline: he ? "מוכן כשתהיו מוכנים" : "Ready when you are",
      body: he
        ? `תוך כדקה אוכל לחקור את העסק שלכם, להראות לכם מה מצאתי ולהמליץ מאיפה להתחיל. המשיכו מהיכן שעצרתם.`
        : `In about a minute I can investigate your business, show you what I find, and recommend where to start. Pick up where you left off.`,
    };
  }
  if (!s.reviewComplete) {
    const extra = refundGap
      ? (he ? `מצאתי הרבה - אבל עדיין לא מצאתי את מדיניות ההחזרים שלכם.` : `I found a lot - but I couldn't find your refund policy yet.`)
      : (he ? `כבר למדתי הרבה על העסק שלכם.` : `I already learned a lot about your business.`);
    return {
      reason: "stopped_after_discovery",
      subject: he ? `כבר ניתחתי את ${company} - הציצו` : `I already analyzed ${company} - take a look`,
      headline: he ? "שמתי לב שעצרתם ממש אחרי גילוי העסק" : "I noticed you stopped right after Business Discovery",
      body: he
        ? `${extra} עברו על מה שמצאתי ואשרו - אתם במרחק כשתי דקות מעובד ה-AI שלכם.`
        : `${extra} Review what I found and confirm - you're about two minutes from your AI employee.`,
    };
  }
  if (!s.goalSelected) {
    return {
      reason: "no_goal",
      subject: he ? `שאלה קצרה אחת עבור ${company}` : `One quick question for ${company}`,
      headline: he ? "נותרה שאלה אחת" : "One question left",
      body: he
        ? `ספרו לי במה תרצו שה-AI יעזור קודם, ואתאים סביב זה את הכול.`
        : `Tell me what you'd like your AI to help with first, and I'll tailor everything around it.`,
    };
  }
  if (refundGap) {
    return {
      reason: "missing_knowledge",
      subject: he ? `${company}: ה-AI שלכם כמעט מוכן` : `${company}: your AI is almost ready`,
      headline: he ? "ה-AI שלכם כמעט מוכן" : "Your AI is almost ready",
      body: he
        ? `חסרה לי רק מדיניות ההחזרים שלכם. למדו אותי את הדבר האחד הזה ואוכל לענות על שאלות החזרים בעצמי.`
        : `I'm only missing your refund policy. Teach me that one thing and I can answer refund questions on my own.`,
    };
  }
  if (!s.crmConnected) {
    return {
      reason: "no_crm",
      subject: he ? `תנו ל-AI שלכם את המפתחות, ${company}` : `Give your AI the keys, ${company}`,
      headline: he ? "חיבור אחד ואנחנו שם" : "One connection away",
      body: he
        ? `חברו את מערכת הלקוחות שלכם כדי שה-AI יידע עם מי הוא מדבר - ואז הוא מוכן לעבודה.`
        : `Connect your customer system so your AI knows who it's talking to - then it's ready to get to work.`,
    };
  }
  if (s.crmConnected && s.channelsConnected === 0) {
    return {
      reason: "crm_then_channel",
      subject: he ? `יופי - ${s.crmSlug} חובר. הבא: וואטסאפ` : `Nice - ${s.crmSlug} connected. Next: WhatsApp`,
      headline: he ? `חיברתם את ${s.crmSlug}. מעולה!` : `You connected ${s.crmSlug}. Great!`,
      body: he
        ? `הצעד הבא הכי טוב הוא וואטסאפ, כדי שה-AI ידבר עם הלקוחות במקום שבו הם כבר מתכתבים אתכם.`
        : `The next best step is WhatsApp, so your AI can talk to your customers where they already message you.`,
    };
  }
  if (!s.aiEmployeeCreated) {
    return {
      reason: "bring_on_board",
      subject: he ? `${company}: עובד ה-AI שלכם מוכן להצטרף` : `${company}: your AI employee is ready to join`,
      headline: he ? "עובד ה-AI שלכם מוכן להצטרף" : "Your AI employee is ready to join",
      body: he
        ? `הכול מוכן. סיימו את ההגדרה כדי לצרף את עובד ה-AI לצוות.`
        : `Everything's prepared. Finish setup to bring your AI employee on board.`,
    };
  }
  return null;
}

// The Voice's email - composed from the shared light premium shell so a nudge
// looks exactly like the product speaking, in the tenant's own language.
export function nudgeHtml(headline: string, body: string, ctaUrl: string, locale = "en"): string {
  const he = locale === "he";
  return renderBrandEmail({
    locale,
    title: "GOTCHA.",
    preheader: body.slice(0, 120),
    eyebrow: he ? "הודעה מעובד ה-AI שלכם" : "A note from your AI employee",
    icon: "&#9889;",
    headline: escapeHtml(headline),
    bodyHtml: emailParagraph(escapeHtml(body), locale),
    cta: { label: he ? "המשיכו בהגדרה" : "Continue setup", url: ctaUrl },
    closingHtml: he
      ? `<p style="margin:0;font-size:13px;color:#8f89a0;line-height:1.7;">אני כאן כשתחזרו - שום דבר לא הולך לאיבוד.</p>`
      : `<p style="margin:0;font-size:13px;color:#8f89a0;line-height:1.7;">I'll be here when you're back &mdash; nothing you've done is lost.</p>`,
    footerNote: he
      ? "זה ה-AI שלכם, ששומר על סביבת העבודה בתנועה. קיבלתם את זה כי ההגדרה שלכם ב-GOTCHA עדיין לא הושלמה."
      : "This is your AI, keeping your workspace moving. You're getting it because your GOTCHA setup isn't finished yet.",
  });
}

// ─── Send ───────────────────────────────────────────────────

export interface NudgeResult {
  tenantId: string;
  outcome: "sent" | "skipped" | "failed" | "no_admin";
  reason?: string;
}

/**
 * Process one scheduled nudge row: recompute content from live state, deliver,
 * and settle the row's status. Never throws - returns the outcome.
 */
export async function processNudgeRow(row: any): Promise<NudgeResult> {
  const tenantId = row.tenantId as string;

  // Atomic claim: PENDING → SENDING before any work. This is the at-most-once
  // guard: even if the post-send settle fails (the bug class that caused a
  // 5-minute email loop - a settle that throws and a row that stays PENDING),
  // a claimed row is never picked up by the sweep again. Worst case is one
  // email and a row parked in SENDING, which the sweep flags as FAILED later.
  const claimed = await prisma.scheduledNudge.updateMany({
    where: { id: row.id, status: "PENDING" },
    data: { status: "SENDING" },
  }).catch(() => ({ count: 0 }));
  if (!claimed.count) return { tenantId, outcome: "skipped", reason: "already_claimed" };

  const snapshot = await getOnboardingSnapshot(tenantId);
  if (!snapshot) {
    await settle(row.id, "CANCELLED");
    return { tenantId, outcome: "skipped", reason: "tenant_gone" };
  }

  // The Voice speaks the tenant's language (he/en).
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { defaultLocale: true } }).catch(() => null);
  const locale = tenant?.defaultLocale || "en";

  const content = contentForSnapshot(snapshot, locale);
  if (!content) {
    await settle(row.id, "SKIPPED");
    return { tenantId, outcome: "skipped", reason: "nothing_to_say" };
  }

  const admin = await prisma.user.findFirst({
    where: { tenantId, role: "ADMIN", isActive: true },
    select: { id: true, email: true, name: true },
    orderBy: { createdAt: "asc" },
  });
  if (!admin?.email) {
    await settle(row.id, "SKIPPED");
    return { tenantId, outcome: "no_admin", reason: content.reason };
  }

  // An admin who never finished setup has no password yet, so the nudge
  // carries an Authentik setup link. If that cannot be minted we fall back to
  // /setup, which bounces through Authentik login anyway.
  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
  let ctaUrl = `${frontendUrl}/setup`;
  try {
    ctaUrl = await createSetupLink(admin.id);
  } catch { /* fall back to bare /setup - still valid */ }

  const html = nudgeHtml(content.headline, content.body, ctaUrl, locale);
  const cta = locale === "he" ? "המשיכו בהגדרה" : "Continue setup";
  const text = `${content.headline}\n\n${content.body}\n\n${cta}: ${ctaUrl}`;
  const ok = await sendNudgeEmail(tenantId, admin.email, content.subject, html, text, row.dedupeKey);

  if (ok) {
    // `reason` is not a column - it rides in the payload Json. (Passing it as
    // a top-level field made the update THROW, the old settle swallowed the
    // error, the row stayed PENDING, and the sweep re-sent the email every
    // 5 minutes. Typed `extra` + the SENDING claim make that impossible now.)
    await settle(row.id, "SENT", { sentAt: new Date(), payload: { reason: content.reason } });
    return { tenantId, outcome: "sent", reason: content.reason };
  }

  const attempts = (row.attempts ?? 0) + 1;
  if (attempts >= MAX_ATTEMPTS) {
    await settle(row.id, "FAILED", { attempts, lastError: "email delivery failed" });
    return { tenantId, outcome: "failed", reason: content.reason };
  }
  // back to PENDING (releasing the claim) → retried next sweep, backed off ~10 min
  await settle(row.id, "PENDING", { attempts, lastError: "email delivery failed", scheduledFor: new Date(Date.now() + 10 * 60_000) });
  return { tenantId, outcome: "failed", reason: content.reason };
}

// Typed extra so tsc validates every field against the Prisma model - the
// spread-of-unknowns version let a non-existent column reach the DB at runtime.
interface SettleExtra {
  sentAt?: Date;
  attempts?: number;
  lastError?: string;
  scheduledFor?: Date;
  payload?: Record<string, unknown>;
}

async function settle(id: string, status: string, extra: SettleExtra = {}): Promise<void> {
  try {
    await prisma.scheduledNudge.update({ where: { id }, data: { status, ...extra, payload: extra.payload as any } });
  } catch (err: any) {
    // Loud, never silent: an unsettled row is exactly how the resend loop is born.
    console.error(`[nudge-engine] FAILED to settle nudge ${id} → ${status}:`, err?.message);
  }
}

/** The sweep: deliver every due PENDING nudge. Idempotent and safe to run on
 *  every interval; only PENDING rows whose time has come are touched. */
export async function sendDueNudges(limit = 100): Promise<{ sent: number; skipped: number; failed: number }> {
  // Failsafe: a row claimed (SENDING) over an hour ago was sent but never
  // settled (crash or settle error). Mark it FAILED for visibility - never
  // back to PENDING, which would re-send the email.
  await prisma.scheduledNudge.updateMany({
    where: { status: "SENDING", updatedAt: { lte: new Date(Date.now() - 60 * 60_000) } },
    data: { status: "FAILED", lastError: "claimed but never settled (see logs)" },
  }).catch(() => {});

  const due = await prisma.scheduledNudge.findMany({
    where: { status: "PENDING", scheduledFor: { lte: new Date() } },
    orderBy: { scheduledFor: "asc" },
    take: limit,
  }).catch(() => []);

  let sent = 0, skipped = 0, failed = 0;
  for (const row of due) {
    const r = await processNudgeRow(row);
    if (r.outcome === "sent") sent++;
    else if (r.outcome === "failed") failed++;
    else skipped++;
  }
  if (due.length > 0) console.log(`[nudge-engine] sweep: ${sent} sent, ${skipped} skipped, ${failed} failed`);
  return { sent, skipped, failed };
}

/**
 * Admin-triggered "send a nudge now" - arms a manual nudge for immediate
 * delivery and processes it inline so the operator gets instant feedback.
 */
export async function triggerNudgeNow(tenantId: string): Promise<NudgeResult> {
  const row = await prisma.scheduledNudge.upsert({
    where: { tenantId_dedupeKey: { tenantId, dedupeKey: "onboarding_manual" } },
    update: { scheduledFor: new Date(), status: "PENDING", kind: ONBOARDING_KIND, channel: "email", attempts: 0, lastError: null },
    create: { tenantId, kind: ONBOARDING_KIND, dedupeKey: "onboarding_manual", scheduledFor: new Date(), status: "PENDING", channel: "email" },
  });
  return processNudgeRow(row);
}

// ─── Worker ─────────────────────────────────────────────────

let _nudgeQueue: Queue | null = null;
function getNudgeQueue(): Queue {
  if (!_nudgeQueue) _nudgeQueue = new Queue(NUDGE_QUEUE_NAME, { connection: { url: REDIS_URL } });
  return _nudgeQueue;
}

/** Start the repeatable sweep + worker. Idempotent (BullMQ dedupes the
 *  repeatable job by its options). Called once at auth boot. */
export async function startNudgeWorker(): Promise<void> {
  const pattern = process.env.NUDGE_SWEEP_CRON || "*/5 * * * *"; // every 5 min
  try {
    await getNudgeQueue().add("sweep", {}, {
      repeat: { pattern },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 50 },
    });
    createWorker(NUDGE_QUEUE_NAME, async () => { await sendDueNudges(); }, 1);
    console.log(`[nudge-engine] worker started (cron="${pattern}")`);
  } catch (err: any) {
    console.error("[nudge-engine] failed to start worker:", err?.message);
  }
}
