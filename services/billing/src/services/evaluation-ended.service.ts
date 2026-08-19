/**
 * What happens when a POC or trial reaches its end date.
 *
 * Until this existed, expiry was silent: the subscription flipped to CANCELED,
 * the feature entitlements switched off, and the customer discovered it by
 * finding the product no longer worked. Nobody was ever asked to subscribe -
 * which is the one thing an evaluation exists to lead to.
 *
 * So expiry now produces an ASK: a state the app can read (`evaluationEnded`
 * on the billing view), and one email naming the plans. Both are derived from
 * the same subscription row rather than a flag somebody has to remember to
 * clear - an evaluation that gets converted stops being "ended" because its
 * subscription is no longer an evaluation, not because a cleanup ran.
 */
import { Queue } from "bullmq";
import {
  prisma,
  renderBrandEmail,
  emailParagraph,
  emailKeyValueTable,
  escapeHtml,
  NOTIFICATIONS_EMAIL_QUEUE_NAME,
  type EmailJobData,
} from "@chatcenter/shared";

const REDIS_URL = process.env.REDIS_URL || "redis://redis:6379";
let _queue: Queue | null = null;
function emailQueue(): Queue {
  if (!_queue) _queue = new Queue(NOTIFICATIONS_EMAIL_QUEUE_NAME, { connection: { url: REDIS_URL } });
  return _queue;
}

/** Test seam, mirroring receipt-email.service. */
export function __setEvaluationEmailQueue(q: Queue | null) {
  _queue = q;
}

export interface EvaluationEndedView {
  /** POC or TRIAL - the customer-facing wording differs. */
  kind: "POC" | "TRIAL";
  planKey: string;
  planName: string;
  endedAt: Date | null;
  /** True while the workspace is still usable but the clock is visible. */
  endingSoon: boolean;
  daysLeft: number | null;
}

/** Days before expiry at which the app starts asking. */
export const EVALUATION_NUDGE_DAYS = 7;

/**
 * Is this subscription an evaluation that has ended, or is about to?
 *
 * Returns null for everything else, so callers can spread it into a response
 * without branching on plan kinds themselves.
 */
export async function evaluationPromptFor(
  sub: {
    planKey: string;
    planVersion: number;
    status: string;
    currentPeriodEnd: Date | null;
    trialPocTemplateKey?: string | null;
  } | null,
  now = new Date(),
): Promise<EvaluationEndedView | null> {
  if (!sub) return null;
  const plan = await prisma.plan.findUnique({
    where: { key_version: { key: sub.planKey, version: sub.planVersion } },
    select: { kind: true, name: true },
  });
  if (!plan || (plan.kind !== "POC" && plan.kind !== "TRIAL")) return null;

  const end = sub.currentPeriodEnd;
  const ended = sub.status === "CANCELED" || (end != null && end.getTime() <= now.getTime());
  const msLeft = end ? end.getTime() - now.getTime() : null;
  const daysLeft = msLeft == null ? null : Math.max(0, Math.ceil(msLeft / 86_400_000));
  const endingSoon = !ended && daysLeft != null && daysLeft <= EVALUATION_NUDGE_DAYS;

  if (!ended && !endingSoon) return null;

  return {
    kind: plan.kind === "POC" ? "POC" : "TRIAL",
    planKey: sub.planKey,
    planName: plan.name,
    endedAt: ended ? end : null,
    endingSoon,
    daysLeft,
  };
}

/**
 * Email the organization that their evaluation has ended and ask them to pick
 * a plan.
 *
 * Best-effort and never throws: the expiry itself has already happened, and a
 * mail-server hiccup must not leave a workspace half-expired. Idempotent per
 * subscription through the queue's eventId.
 */
export async function sendEvaluationEndedEmail(input: {
  tenantId: string;
  subscriptionId: string;
  kind: "POC" | "TRIAL";
  planName: string;
}): Promise<boolean> {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: input.tenantId },
      select: { name: true, defaultLocale: true },
    });
    const admin = await prisma.user.findFirst({
      where: { tenantId: input.tenantId, isActive: true, role: { in: ["ADMIN", "SYSTEM_ADMIN"] } },
      select: { email: true, name: true },
      orderBy: { createdAt: "asc" },
    });
    if (!admin?.email) return false;

    const he = String(tenant?.defaultLocale ?? "en").toLowerCase().startsWith("he");
    const locale = he ? "he" : "en";
    const what = input.kind === "POC" ? (he ? "הפיילוט" : "your proof of concept") : he ? "תקופת הניסיון" : "your trial";
    const appUrl = process.env.FRONTEND_URL || "https://app.gotcha.co.il";

    const html = renderBrandEmail({
      title: he ? "בחרו תוכנית כדי להמשיך" : "Choose a plan to keep going",
      preheader: he
        ? `${what} הסתיים. בחירת תוכנית מחזירה הכל לפעולה.`
        : `${what} has ended. Picking a plan turns everything back on.`,
      eyebrow: he ? "סיום תקופת התנסות" : "Evaluation ended",
      headline: he ? "רוצים להמשיך?" : "Ready to keep going?",
      subhead: he
        ? `${what} של ${escapeHtml(tenant?.name ?? "")} הסתיים. הנתונים, השיחות וההגדרות שלכם נשמרו במלואם - בחירת תוכנית מפעילה אותם מחדש.`
        : `${what} for ${escapeHtml(tenant?.name ?? "")} has ended. Your data, conversations and settings are all still here - choosing a plan switches them back on.`,
      bodyHtml: [
        emailKeyValueTable(
          [he ? "מה הסתיים" : "What ended", ""],
          [[he ? "תוכנית ההתנסות" : "Evaluation plan", escapeHtml(input.planName)]],
          locale,
        ),
        emailParagraph(
          he
            ? "אם יש לכם קופון הנחה, אפשר להזין אותו מולנו לפני המעבר ונחיל אותו על החיוב."
            : "If you have a discount coupon, tell us before you switch and we will apply it to your billing.",
          locale,
        ),
      ].join(""),
      cta: { label: he ? "בחירת תוכנית" : "Choose a plan", url: `${appUrl}/settings/billing` },
      footerNote: he
        ? "קיבלתם את המייל הזה כי אתם מנהלים את החשבון."
        : "You received this because you administer this account.",
      locale,
    });

    const job: EmailJobData = {
      tenantId: input.tenantId,
      userId: "",
      to: admin.email,
      eventType: "billing.evaluation_ended",
      // One per subscription: a retried expiry sweep must not re-mail anyone.
      eventId: `evaluation-ended:${input.subscriptionId}`,
      priority: "high",
      subject: he ? "בחרו תוכנית כדי להמשיך ב-GOTCHA" : "Choose a plan to keep using GOTCHA",
      body: he
        ? `${what} הסתיים. הנתונים שלכם נשמרו. בחרו תוכנית: ${appUrl}/settings/billing`
        : `${what} has ended. Your data is safe. Choose a plan: ${appUrl}/settings/billing`,
      link: `${appUrl}/settings/billing`,
      html,
      bypassRateLimit: true,
    };

    await emailQueue().add("send-email", job, {
      removeOnComplete: 1000,
      removeOnFail: 100,
      attempts: 5,
      backoff: { type: "exponential", delay: 2_000 },
    });
    return true;
  } catch (err: any) {
    console.warn("[billing] evaluation-ended email could not be queued:", err?.message ?? err);
    return false;
  }
}
