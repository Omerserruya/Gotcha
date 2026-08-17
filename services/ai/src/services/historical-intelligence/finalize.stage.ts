import { Queue } from "bullmq";
import {
  prisma,
  renderBrandEmail,
  emailParagraph,
  emailStatCards,
  emailPills,
  escapeHtml,
  resolveEffectiveLocale,
  NOTIFICATIONS_EMAIL_QUEUE_NAME,
  type EmailJobData,
} from "@chatcenter/shared";
import { recordEvent, type StageResult } from "./stage-utils";

/**
 * Close the import and tell the owner, once.
 *
 * ── When ──
 *
 * Not when the source reports 100. That only means the messages arrived, and an
 * email at that moment sends somebody to a page showing a spinner. The email
 * goes out after ingest, identity resolution, customer learning, knowledge
 * mining and analytics have all finished and there is something to look at.
 *
 * ── Exactly once ──
 *
 * `completionEmailSentAt` is a latch, claimed with a conditional update. Any
 * number of retries can race to finish an import; whichever one moves the
 * column from null wins and enqueues, and the losers update zero rows and send
 * nothing. Doing this with a read-then-write would leave the usual gap between
 * the two, which under BullMQ retries is not theoretical.
 *
 * The claim is taken BEFORE the mail is queued rather than after. The failure
 * modes are not equal: claiming first risks the owner missing one email, which
 * they can recover from by opening the page the channel card already links to.
 * Queueing first risks sending the same email repeatedly, which is the kind of
 * thing that gets a sending domain blocked.
 */

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

let _queue: Queue | null = null;
function emailQueue(): Queue {
  if (!_queue) _queue = new Queue(NOTIFICATIONS_EMAIL_QUEUE_NAME, { connection: { url: REDIS_URL } });
  return _queue;
}

/** Test seam, mirroring the one in the billing receipt sender. */
export function __setEmailQueueForTests(q: Queue | null): void {
  _queue = q;
}

export async function runFinalizeStage(args: {
  tenantId: string;
  importId: string;
}): Promise<StageResult> {
  const { tenantId, importId } = args;
  const startedAt = Date.now();

  const importRow = await prisma.historicalImport.findFirst({
    where: { id: importId, tenantId },
  });
  if (!importRow) return { ok: false };

  const now = new Date();
  await prisma.historicalImport.updateMany({
    where: { id: importId, tenantId, reviewReadyAt: null },
    data: { reviewReadyAt: now },
  });
  await prisma.historicalImport.updateMany({
    where: { id: importId, tenantId, status: { notIn: ["COMPLETED", "FAILED", "NOT_AVAILABLE"] } },
    data: { status: "REVIEW_READY" },
  });

  // ── The latch ──
  const claimed = await prisma.historicalImport.updateMany({
    where: { id: importId, tenantId, completionEmailSentAt: null },
    data: { completionEmailSentAt: now },
  });

  if (claimed.count === 0) {
    await prisma.historicalImport.updateMany({
      where: { id: importId, tenantId, status: "REVIEW_READY" },
      data: { status: "COMPLETED", completedAt: now },
    });
    await recordEvent(importId, "EMAIL", "SKIPPED", "already sent");
    return { ok: true, detail: { emailed: false, reason: "already sent" } };
  }

  const recipients = await resolveOwners(tenantId);
  if (recipients.length === 0) {
    await recordEvent(importId, "EMAIL", "SKIPPED", "no owner to notify");
  } else {
    const summary = (importRow.summary ?? {}) as Record<string, any>;
    const topics = Array.isArray(importRow.topTopics) ? (importRow.topTopics as any[]) : [];

    for (const recipient of recipients) {
      const locale = await safeLocale(tenantId, recipient.userId);
      const { subject, html, text } = buildCompletionEmail({
        locale,
        messages: Number(summary.importedMessages ?? importRow.importedMessages ?? 0),
        customers: Number(summary.importedCustomers ?? importRow.importedCustomers ?? 0),
        candidates: Number(summary.knowledgeCandidates ?? importRow.knowledgeCandidateCount ?? 0),
        conflicts: Number(summary.knowledgeConflicts ?? importRow.knowledgeConflictCount ?? 0),
        topics: topics.slice(0, 3).map((t) => String(t.topic ?? "")).filter(Boolean),
      });

      await emailQueue().add(
        "send",
        {
          tenantId,
          userId: recipient.userId,
          to: recipient.email,
          eventType: "historical_import_ready",
          // The import id makes the event id stable, so a duplicate enqueue is
          // recognisable downstream as the same event rather than a new one.
          eventId: `historical-import:${importId}`,
          priority: "normal",
          subject,
          body: text,
          html,
        } satisfies EmailJobData,
        { attempts: 3, backoff: { type: "exponential", delay: 5000 } },
      );
    }
    await recordEvent(importId, "EMAIL", "SUCCESS", null, { recipients: recipients.length });
  }

  await prisma.historicalImport.updateMany({
    where: { id: importId, tenantId, status: { notIn: ["COMPLETED", "FAILED", "NOT_AVAILABLE"] } },
    data: { status: "COMPLETED", completedAt: now },
  });

  await recordEvent(
    importId,
    "FINALIZE",
    "SUCCESS",
    null,
    { recipients: recipients.length },
    Date.now() - startedAt,
  );

  return { ok: true, detail: { emailed: recipients.length > 0, recipients: recipients.length } };
}

/**
 * Who hears about this.
 *
 * The tenant's admins, oldest first, capped at three. Not every user: an import
 * completing is a business-owner event, and mailing every seat about it is how
 * a product earns a filter rule. SYSTEM_ADMIN is excluded on purpose - that is
 * a GOTCHA operator, not the business, and a customer's import finishing is not
 * their news.
 */
async function resolveOwners(
  tenantId: string,
): Promise<Array<{ userId: string; email: string }>> {
  const users = await prisma.user.findMany({
    where: { tenantId, role: "ADMIN", isActive: true },
    select: { id: true, email: true },
    orderBy: { createdAt: "asc" },
    take: 3,
  });
  return users
    .filter((u) => !!u.email)
    .map((u) => ({ userId: u.id, email: u.email as string }));
}

async function safeLocale(tenantId: string, userId: string): Promise<string> {
  try {
    const locale = await resolveEffectiveLocale({ tenantId, userId } as any);
    return typeof locale === "string" && locale ? locale : "en";
  } catch {
    return "en";
  }
}

/**
 * The completion email.
 *
 * Every number in it comes from the persisted summary, which is the same object
 * the channel card and the results page read. Three surfaces quoting one row is
 * what stops an email saying 12,482 while the page says 11,903.
 *
 * No em dashes anywhere in the copy: the repository rule, because they read as
 * machine-written.
 */
export function buildCompletionEmail(args: {
  locale: string;
  messages: number;
  customers: number;
  candidates: number;
  conflicts: number;
  topics: string[];
}): { subject: string; html: string; text: string } {
  const he = args.locale === "he";
  const n = (v: number) => v.toLocaleString(he ? "he-IL" : "en-US");

  const subject = he
    ? "סיימנו ללמוד מהיסטוריית הוואטסאפ שלכם"
    : "GOTCHA finished learning from your WhatsApp history";

  const headline = he ? "היסטוריית הוואטסאפ שלכם מוכנה" : "Your WhatsApp history is ready";

  const intro = he
    ? "עברנו על השיחות הקודמות שלכם, זיהינו את הלקוחות שכבר דיברו איתכם, ואספנו את הידע שחוזר בהן שוב ושוב."
    : "We went through your previous conversations, identified the customers who have already spoken with you, and gathered the knowledge that comes up in them again and again.";

  const cards = emailStatCards(
    [
      { label: he ? "הודעות שנותחו" : "Messages analyzed", value: n(args.messages) },
      { label: he ? "לקוחות שזוהו" : "Customers identified", value: n(args.customers) },
      {
        label: he ? "פריטי ידע שנמצאו" : "Knowledge items found",
        value: n(args.candidates),
      },
    ],
    args.locale,
  );

  const topicsBlock =
    args.topics.length > 0
      ? emailPills(
          he ? "הנושאים שהלקוחות שלכם הכי שואלים עליהם" : "What your customers ask about most",
          args.topics.map((t) => escapeHtml(t)),
          args.locale,
        )
      : "";

  // Stated plainly rather than buried. The owner is about to be asked to
  // approve things, and they should walk in knowing that approval is the point
  // and that some of it disagrees with itself.
  const reviewNote = he
    ? args.conflicts > 0
      ? `מתוכם ${n(args.conflicts)} פריטים שבהם מצאנו תשובות סותרות שניתנו ללקוחות שונים. שווה להעיף מבט ולהחליט מה נכון היום.`
      : "שום דבר לא נכנס למאגר הידע לפני שתאשרו אותו."
    : args.conflicts > 0
      ? `${n(args.conflicts)} of them are places where different answers were given to different customers. Worth a look, so you can decide which one is right today.`
      : "Nothing enters your knowledge base until you approve it.";

  const html = renderBrandEmail({
    title: subject,
    preheader: he
      ? `${n(args.messages)} הודעות, ${n(args.customers)} לקוחות, ${n(args.candidates)} פריטי ידע`
      : `${n(args.messages)} messages, ${n(args.customers)} customers, ${n(args.candidates)} knowledge items`,
    eyebrow: he ? "ייבוא היסטוריה" : "History import",
    icon: "📚",
    headline,
    subhead: intro,
    bodyHtml: `${cards}${topicsBlock}${emailParagraph(escapeHtml(reviewNote), args.locale)}`,
    cta: {
      label: he ? "לראות מה GOTCHA למד" : "Review what GOTCHA learned",
      url: `${appUrl()}/ai-studio/knowledge?tab=discovered`,
    },
    footerNote: he
      ? "קיבלתם את המייל הזה כי חיברתם את הוואטסאפ העסקי שלכם ל-GOTCHA."
      : "You are receiving this because you connected your WhatsApp Business account to GOTCHA.",
    locale: args.locale,
  });

  const text = he
    ? [
        headline,
        "",
        `הודעות שנותחו: ${n(args.messages)}`,
        `לקוחות שזוהו: ${n(args.customers)}`,
        `פריטי ידע שנמצאו: ${n(args.candidates)}`,
        "",
        reviewNote,
        "",
        `${appUrl()}/ai-studio/knowledge?tab=discovered`,
      ].join("\n")
    : [
        headline,
        "",
        `Messages analyzed: ${n(args.messages)}`,
        `Customers identified: ${n(args.customers)}`,
        `Knowledge items found: ${n(args.candidates)}`,
        "",
        reviewNote,
        "",
        `${appUrl()}/ai-studio/knowledge?tab=discovered`,
      ].join("\n");

  return { subject, html, text };
}

function appUrl(): string {
  return (process.env.FRONTEND_URL || "https://app.gotcha.co.il").replace(/\/+$/, "");
}
