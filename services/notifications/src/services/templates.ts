/**
 * Notification templates per SystemEventType.
 *
 * Templates render to a {title, body} pair used both for in-app rows and
 * the email subject + body, in ONE language: the recipient's (their own
 * override, else the workspace's). Each template writes both languages as
 * separate texts and renderTemplate picks one. They used to be glued into one
 * body with a "- Hebrew -" divider and an English-only title, so every reader
 * saw both languages at once (2026-10-08).
 *
 * Templates are pure functions of `event.data` - no I/O. The dispatcher
 * passes `event.data` straight through; missing fields show "n/a".
 */

import type { SystemEvent, SystemEventType } from "./event-emitter.service";
import type { TemplateLocale } from "./platform-whatsapp";

export interface RenderedTemplate {
  /** Short, used as in-app `title` and email `subject`. */
  title: string;
  /** Plain-text body. The email worker wraps this in HTML. */
  body: string;
  /** Optional dashboard link - used as `link` on the InAppNotification row. */
  link?: string;
}

interface Text { title: string; body: string }
interface Bilingual { en: Text; he: Text; link?: string }
type TemplateFn = (event: SystemEvent) => Bilingual;

const safe = (v: unknown, fallback = "n/a"): string => {
  if (v === undefined || v === null || v === "") return fallback;
  if (typeof v === "string") return v;
  try { return JSON.stringify(v); } catch { return fallback; }
};
const convLink = (e: SystemEvent) => (e.metadata.conversationId ? `/conversations/${e.metadata.conversationId}` : undefined);
/** "on WhatsApp" / "בוואטסאפ": the channel as a place, with its preposition. */
const ON_CHANNEL: Record<string, { en: string; he: string }> = {
  WHATSAPP: { en: "on WhatsApp", he: "בוואטסאפ" },
  INSTAGRAM: { en: "on Instagram", he: "באינסטגרם" },
  MESSENGER: { en: "on Messenger", he: "במסנג'ר" },
  EMAIL: { en: "by email", he: "באימייל" },
  GMAIL: { en: "on Gmail", he: "ב-Gmail" },
  OUTLOOK: { en: "on Outlook", he: "ב-Outlook" },
  SLACK: { en: "on Slack", he: "ב-Slack" },
  VOICE: { en: "by phone", he: "בטלפון" },
  WEBCHAT: { en: "on the website chat", he: "בצ'אט באתר" },
  SHOPIFY_LIVE_CHAT: { en: "on the Shopify chat", he: "בצ'אט של Shopify" },
};
/** A storefront visitor's placeholder name ("Shopper on x.myshopify.com") said as people say it. */
const customerName = (raw: string, locale: TemplateLocale): string => {
  const shopper = /^(signed-in )?shopper on \S+$/i.exec(raw.trim());
  if (!shopper) return raw.trim();
  return shopper[1] ? (locale === "he" ? "קונה מחובר באתר" : "a signed-in website shopper") : (locale === "he" ? "קונה באתר" : "a website shopper");
};
/** "The conversation with Dana on WhatsApp"; empty when the event names neither. */
function whichConversation(e: SystemEvent, locale: TemplateLocale): string {
  const name = safe(e.data.customerName, "");
  const on = ON_CHANNEL[safe(e.data.channel, "").toUpperCase()]?.[locale] ?? "";
  if (!name && !on) return "";
  if (locale === "he") return `השיחה${name ? ` עם ${customerName(name, "he")}` : ""}${on ? ` ${on}` : ""}.`;
  return `The conversation${name ? ` with ${customerName(name, "en")}` : ""}${on ? ` ${on}` : ""}.`;
}

/** GOTCHA is feminine in Hebrew; a person's gender is unknown, so "העביר/ה". */
const isGotcha = (name: string) => /^gotcha$/i.test(name.trim());

const TEMPLATES: Record<SystemEventType, TemplateFn> = {
  "tool.approval_required": (e) => {
    const tool = safe(e.data.tool, "");
    const summary = safe(e.data.summary, "");
    return {
      en: {
        title: `Approval needed${tool ? `: ${tool}` : ""}`,
        body: `An AI agent is requesting approval to run ${tool || "a tool"}.` + (summary ? `\nReason: ${summary}` : ""),
      },
      he: {
        title: "נדרש אישור",
        body: `GOTCHA מבקשת אישור להפעלת ${tool ? `הכלי ${tool}` : "כלי"}.` + (summary ? ` סיבה: ${summary}` : ""),
      },
      link: e.metadata.conversationId ? `/conversations/${e.metadata.conversationId}` : "/approvals",
    };
  },

  "lead.created": (e) => {
    const name = safe(e.data.name, "");
    const value = safe(e.data.valueEstimate, "");
    return {
      en: { title: `New lead: ${name || "Unnamed lead"}`, body: `A new lead was created${value ? ` with estimated value ${value}` : ""}.` },
      he: { title: `ליד חדש${name ? `: ${name}` : ""}`, body: `נוצר ליד חדש${name ? `: ${name}` : ""}${value ? ` (ערך משוער ${value})` : ""}.` },
      link: "/contacts",
    };
  },

  "meeting.scheduled": (e) => {
    const at = safe(e.data.startAt ?? e.data.scheduledFor, "");
    return {
      en: { title: `Meeting scheduled${at ? ` for ${at}` : ""}`, body: `A meeting was successfully scheduled${at ? ` for ${at}` : ""}.` },
      he: { title: "נקבעה פגישה", body: at ? `נקבעה פגישה ל-${at}.` : "" },
      link: convLink(e),
    };
  },

  "discount.applied": (e) => {
    const amount = safe(e.data.amount ?? e.data.percent, "");
    return {
      en: { title: `Discount applied${amount ? `: ${amount}` : ""}`, body: `A discount was applied to a customer order.${amount ? ` Amount: ${amount}.` : ""}` },
      he: { title: `הוחלה הנחה${amount ? `: ${amount}` : ""}`, body: `הוחלה הנחה על הזמנה של לקוח.${amount ? ` סכום: ${amount}.` : ""}` },
      link: convLink(e),
    };
  },

  // "Finished", not "succeeded": a broadcast completes when every recipient
  // reaches a terminal state, and failures are terminal. Reporting only the
  // sent count would read as success to someone whose send half failed.
  "broadcast.completed": (e) => {
    const name = safe(e.data.name, "");
    const sent = safe(e.data.sentCount, "0");
    const failed = safe(e.data.failedCount, "0");
    const hadFailures = String(failed) !== "0";
    return {
      en: {
        title: `${name || "Your campaign"}: finished`,
        body: `${name || "Your campaign"} has finished sending. ${sent} delivered${hadFailures ? `, ${failed} failed` : ""}.`,
      },
      he: {
        title: `הקמפיין ${name ? `${name} ` : ""}הסתיים`,
        body: `הקמפיין ${name ? `${name} ` : ""}סיים לשלוח. נשלחו: ${sent}${hadFailures ? `, נכשלו: ${failed}` : ""}.`,
      },
      link: "/broadcasts",
    };
  },

  // Fires only on a transfer to a different agent. The `assignedBy` name is
  // what makes this actionable - "a conversation was assigned to you" without
  // saying by whom is a task with no context.
  // Two senders reach this: a person reassigning (assignedByName), and a
  // department transfer where the system chose by lowest workload and there is
  // no "by" at all (departmentName). Naming the department in the second case
  // matters - otherwise the notification cannot say why this landed on you.
  // The conversation service sends "Unknown" when the conversation had no
  // previous agent: that is no name, never a person called Unknown.
  "conversation.assigned": (e) => {
    const rawBy = safe(e.data.assignedByName, "");
    const by = rawBy === "Unknown" ? "" : rawBy;
    const dept = safe(e.data.departmentName, "");
    return {
      // The body says which conversation; it never repeats the title. Nothing to add: empty.
      en: {
        title: by ? `${by} assigned you a conversation` : dept ? `A conversation was routed to you in ${dept}` : "A conversation was assigned to you",
        body: whichConversation(e, "en"),
      },
      he: {
        title: by ? `${by} ${isGotcha(by) ? "העבירה" : "העביר/ה"} אליך שיחה` : dept ? `שיחה נותבה אליך במחלקת ${dept}` : "שיחה הועברה אליך",
        body: whichConversation(e, "he"),
      },
      link: convLink(e),
    };
  },

  // Worded as a CHECK, not as monitoring. The underlying write happens when
  // someone tests the connection and the failure looked like auth, so saying
  // "stopped responding" would claim both a watcher we do not run and an
  // outage we did not observe.
  "integration.check_failed": (e) => {
    const name = safe(e.data.displayName ?? e.data.slug, "");
    const reason = safe(e.data.reason, "");
    return {
      en: {
        title: `${name || "A connected system"}: connection check failed`,
        body: `We checked ${name || "a connected system"} and it rejected our credentials, so GOTCHA cannot use it until it is reconnected.${reason ? ` Reported: ${reason}` : ""}`,
      },
      he: {
        title: `בדיקת החיבור ${name ? `ל-${name} ` : ""}נכשלה`,
        body: `בדקנו את החיבור${name ? ` ל-${name}` : ""} וההתחברות נדחתה. GOTCHA לא תוכל להשתמש בו עד שיחובר מחדש.${reason ? ` דווח: ${reason}` : ""}`,
      },
      link: "/settings/business-systems",
    };
  },

  // The counterpart to refund.issued / discount.applied / meeting.scheduled.
  // Only reaches here for failure === "errored" - a refusal never emits - so
  // the body may say the action was attempted, which a refusal could not.
  // The provider's own reason is shown verbatim: a paraphrased vendor error is
  // a worse debugging aid than an ugly one.
  "tool.action_failed": (e) => {
    const kind = safe(e.data.kind, "action");
    const label =
      kind === "refund" ? "A refund" : kind === "discount" ? "A discount" : kind === "meeting" ? "A meeting booking" : "An action";
    const heLabel =
      kind === "refund" ? "ההחזר" : kind === "discount" ? "ההנחה" : kind === "meeting" ? "קביעת הפגישה" : "הפעולה";
    const reason = safe(e.data.reason, "");
    return {
      en: { title: `${label} did not go through`, body: `${label} was attempted and failed, so it did NOT happen.${reason ? ` Reported: ${reason}` : ""}` },
      he: { title: `${heLabel} לא בוצע${kind === "refund" ? "" : "ה"}`, body: `הניסיון לבצע את ${heLabel} נכשל, ולכן לא בוצע דבר.${reason ? ` דווח: ${reason}` : ""}` },
      link: convLink(e),
    };
  },

  "refund.issued": (e) => {
    const amount = safe(e.data.amount, "");
    return {
      en: { title: `Refund issued${amount ? `: ${amount}` : ""}`, body: `A refund was issued.${amount ? ` Amount: ${amount}.` : ""}` },
      he: { title: `בוצע החזר${amount ? `: ${amount}` : ""}`, body: amount ? `בוצע החזר בסך ${amount}.` : "" },
      link: convLink(e),
    };
  },

  "conversation.escalated": (e) => {
    const reason = safe(e.data.reason, "");
    return {
      en: { title: "Conversation escalated", body: `A conversation was escalated to a human. Reason: ${reason || "human handoff requested"}.` },
      he: { title: "שיחה הועברה לנציג", body: `שיחה הועברה לנציג אנושי.${reason ? ` סיבה: ${reason}.` : ""}` },
      link: convLink(e),
    };
  },

  "high_value_lead.detected": (e) => {
    const value = safe(e.data.valueEstimate, "");
    const name = safe(e.data.name, "");
    return {
      en: { title: `High-value lead detected: ${name || "Unnamed lead"}`, body: `A high-value lead was detected (estimated ${value || "high"}).` },
      he: { title: `ליד בעל ערך גבוה${name ? `: ${name}` : ""}`, body: `זוהה ליד בעל ערך גבוה${name ? `: ${name}` : ""}${value ? ` (ערך משוער ${value})` : ""}.` },
      link: "/contacts",
    };
  },

  "payment.failed": (e) => {
    const reason = safe(e.data.reason, "");
    return {
      en: { title: "Payment failed", body: `A customer payment failed.${reason ? ` Reason: ${reason}.` : ""}` },
      he: { title: "תשלום נכשל", body: `תשלום של לקוח נכשל.${reason ? ` סיבה: ${reason}.` : ""}` },
      link: convLink(e),
    };
  },

  "system.error.critical": (e) => {
    const msg = safe(e.data.message, "");
    return {
      en: { title: "Critical system error", body: `A critical system error was reported: ${msg || "Unknown error"}` },
      he: { title: "שגיאת מערכת קריטית", body: `דווחה שגיאת מערכת קריטית${msg ? `: ${msg}` : ""}.` },
      link: "/system/health",
    };
  },

  // ── Billing · subscription · AI Units ──────────────────────────────────────
  "subscription.trial_started": (e) => {
    const ends = safe(e.data.trialEndsAt, "");
    return {
      en: { title: "Your free trial has started", body: `Your 14-day trial is active${ends ? ` until ${ends}` : ""}. Your card will be charged automatically when it ends.` },
      he: { title: "תקופת הניסיון החלה", body: `תקופת הניסיון בת 14 הימים פעילה${ends ? ` עד ${ends}` : ""}. בסופה הכרטיס יחויב אוטומטית.` },
      link: "/settings/billing",
    };
  },
  "subscription.trial_ending": (e) => {
    const ends = safe(e.data.trialEndsAt, "");
    return {
      en: { title: `Your trial ends ${ends || "soon"}`, body: `Your trial ends ${ends || "soon"} and your first charge will run automatically.` },
      he: { title: ends ? `תקופת הניסיון מסתיימת ב-${ends}` : "תקופת הניסיון מסתיימת בקרוב", body: `תקופת הניסיון מסתיימת${ends ? ` ב-${ends}` : " בקרוב"} והחיוב הראשון יבוצע אוטומטית.` },
      link: "/settings/billing",
    };
  },
  "subscription.activated": (e) => {
    const plan = safe(e.data.planKey, "");
    return {
      en: { title: "Subscription active", body: `Your ${plan ? `${plan} ` : ""}subscription is active.` },
      he: { title: "המנוי פעיל", body: `המנוי שלך פעיל${plan ? ` (${plan})` : ""}.` },
      link: "/settings/billing",
    };
  },
  "subscription.plan_changed": (e) => {
    const to = safe(e.data.to, "");
    const when = safe(e.data.when, "");
    const atEnd = when === "period_end";
    return {
      en: {
        title: `Plan change ${when === "immediate" ? "applied" : "scheduled"}`,
        body: `Your plan will change to ${to}${atEnd ? " at the end of the current billing period" : " now"}.`,
      },
      he: {
        title: when === "immediate" ? "תוכנית המנוי שונתה" : "שינוי תוכנית נקבע",
        body: `תוכנית המנוי תשתנה${to ? ` ל-${to}` : ""}${atEnd ? " בסוף תקופת החיוב הנוכחית" : " עכשיו"}.`,
      },
      link: "/settings/billing",
    };
  },
  "subscription.canceled": (e) => {
    const at = safe(e.data.effectiveAt, "");
    return {
      en: { title: "Subscription cancellation scheduled", body: `Your subscription will end${at ? ` on ${at}` : " at the end of the current period"}. You can resume anytime before then.` },
      he: { title: "ביטול המנוי נקבע", body: `המנוי יסתיים${at ? ` ב-${at}` : " בסוף התקופה הנוכחית"}. אפשר לחדש אותו עד אז.` },
      link: "/settings/billing",
    };
  },
  "subscription.resumed": () => ({
    en: { title: "Subscription resumed", body: "Your subscription will continue as normal." },
    he: { title: "המנוי חודש", body: "המנוי שלך ימשיך כרגיל." },
    link: "/settings/billing",
  }),
  "subscription.suspended": (e) => {
    const reason = safe(e.data.reason, "");
    return {
      en: { title: "Subscription suspended", body: `AI features are paused due to a billing issue${reason ? ` (${reason})` : ""}. Update your payment method to restore service.` },
      he: { title: "המנוי הושעה", body: `תכונות ה-AI מושהות בגלל בעיית חיוב${reason ? ` (${reason})` : ""}. עדכנו את אמצעי התשלום כדי לחדש את השירות.` },
      link: "/settings/billing",
    };
  },
  "subscription.past_due": () => ({
    en: { title: "Payment overdue", body: "We couldn't renew your subscription. We'll retry shortly - please check your payment method." },
    he: { title: "התשלום באיחור", body: "לא הצלחנו לחדש את המנוי. ננסה שוב בקרוב; כדאי לבדוק את אמצעי התשלום." },
    link: "/settings/billing",
  }),
  "invoice.issued": (e) => {
    const amount = safe(e.data.amount, "");
    return {
      en: { title: "New invoice", body: `A new invoice was issued${amount ? ` (${amount})` : ""}.` },
      he: { title: "חשבונית חדשה", body: `הונפקה חשבונית חדשה${amount ? ` (${amount})` : ""}.` },
      link: "/settings/billing/invoices",
    };
  },
  "invoice.paid": (e) => {
    const amount = safe(e.data.amount, "");
    return {
      en: { title: "Payment received", body: `Your payment${amount ? ` of ${amount}` : ""} was received. Thank you!` },
      he: { title: "התשלום התקבל", body: `התשלום${amount ? ` בסך ${amount}` : ""} התקבל. תודה!` },
      link: "/settings/billing/invoices",
    };
  },
  "payment_method.expiring": (e) => {
    const last4 = safe(e.data.last4, "");
    return {
      en: { title: "Card expiring soon", body: `Your card${last4 ? ` ending ${last4}` : ""} is expiring. Update it to avoid service interruption.` },
      he: { title: "תוקף הכרטיס עומד לפוג", body: `תוקף הכרטיס${last4 ? ` שמסתיים ב-${last4}` : ""} עומד לפוג. עדכנו אותו כדי למנוע הפסקת שירות.` },
      link: "/settings/billing",
    };
  },
  "credit.threshold": (e) => {
    const pct = safe(e.data.pct, "");
    return {
      en: { title: `AI Units: ${pct}% used`, body: `You've used ${pct}% of your monthly AI Units. Buy more or enable auto-purchase to avoid interruption.` },
      he: { title: `ניצלתם ${pct}% מיחידות ה-AI`, body: `ניצלתם ${pct}% מיחידות ה-AI החודשיות. אפשר לרכוש עוד או להפעיל רכישה אוטומטית.` },
      link: "/settings/billing/credits",
    };
  },
  "credit.exhausted": () => ({
    en: { title: "AI Units exhausted", body: "Your AI Units are used up. AI features are paused until you add more; the rest of the platform works normally." },
    he: { title: "יחידות ה-AI נגמרו", body: "יחידות ה-AI נגמרו. תכונות ה-AI מושהות עד שיתווספו עוד; שאר המערכת פועלת כרגיל." },
    link: "/settings/billing/credits",
  }),
  "credit.auto_purchase_succeeded": (e) => {
    const units = safe(e.data.units, "");
    return {
      en: { title: "Auto-purchase successful", body: `${units ? `${units} ` : ""}AI Units were added automatically.` },
      he: { title: "הרכישה האוטומטית הצליחה", body: `נוספו${units ? ` ${units}` : ""} יחידות AI אוטומטית.` },
      link: "/settings/billing/credits",
    };
  },
  "credit.auto_purchase_failed": () => ({
    en: { title: "Auto-purchase failed", body: "We couldn't auto-purchase AI Units. Please check your payment method." },
    he: { title: "הרכישה האוטומטית נכשלה", body: "לא הצלחנו לרכוש יחידות AI אוטומטית. בדקו את אמצעי התשלום." },
    link: "/settings/billing/credits",
  }),
  "credit.auto_purchase_ceiling_reached": (e) => {
    const ceiling = safe(e.data.ceiling, "");
    return {
      en: { title: "Auto-purchase monthly limit reached", body: `Auto-purchase hit your monthly spend limit${ceiling ? ` (${ceiling})` : ""}. Buy AI Units manually to continue.` },
      he: { title: "הרכישה האוטומטית הגיעה לתקרה", body: `הרכישה האוטומטית הגיעה לתקרת ההוצאה החודשית${ceiling ? ` (${ceiling})` : ""}. אפשר לרכוש יחידות AI ידנית.` },
      link: "/settings/billing/credits",
    };
  },
};

/** One language: the recipient's. English when the locale is anything else. */
export function renderTemplate(event: SystemEvent, locale: TemplateLocale = "en"): RenderedTemplate {
  const fn = TEMPLATES[event.type];
  // Fallback for unknown event types - shouldn't happen but stay safe.
  const t: Bilingual = fn
    ? fn(event)
    : {
        en: { title: `Notification: ${event.type}`, body: `Event ${event.type} fired.\nData: ${safe(event.data, "{}")}.` },
        he: { title: "התראה", body: `התקבלה התראה: ${event.type}.` },
      };
  const text = locale === "he" ? t.he : t.en;
  return { title: text.title, body: text.body, ...(t.link ? { link: t.link } : {}) };
}

/** The old divider: rows written before 2026-10-08 hold both languages in one body. */
const OLD_DIVIDER = /\n{1,2}- Hebrew -\n/;
/** A stored body in the reader's language: an old two-language body is cut at its divider. */
export function oneLanguage(body: string, locale: TemplateLocale): string {
  const m = OLD_DIVIDER.exec(body);
  if (!m) return body;
  return (locale === "he" ? body.slice(m.index + m[0].length) : body.slice(0, m.index)).trim();
}
