/**
 * Notification templates per SystemEventType.
 *
 * Templates render to a {title, body} pair used both for in-app rows and
 * the email subject + body. Bilingual (EN/HE) - we tag both in the same
 * payload, separated by a divider, mirroring the dashboard's i18n convention.
 *
 * Templates are pure functions of `event.data` - no I/O. The dispatcher
 * passes `event.data` straight through; missing fields show "n/a".
 */

import type { SystemEvent, SystemEventType } from "./event-emitter.service";

export interface RenderedTemplate {
  /** Short, used as in-app `title` and email `subject`. */
  title: string;
  /** Plain-text body. The email worker wraps this in HTML. */
  body: string;
  /** Optional dashboard link - used as `link` on the InAppNotification row. */
  link?: string;
}

type TemplateFn = (event: SystemEvent) => RenderedTemplate;

const safe = (v: unknown, fallback = "n/a"): string => {
  if (v === undefined || v === null || v === "") return fallback;
  if (typeof v === "string") return v;
  try { return JSON.stringify(v); } catch { return fallback; }
};

const TEMPLATES: Record<SystemEventType, TemplateFn> = {
  "tool.approval_required": (e) => {
    const tool = safe(e.data.tool, "a tool");
    const summary = safe(e.data.summary, "");
    return {
      title: `Approval needed: ${tool}`,
      body:
        `An AI agent is requesting approval to run ${tool}.\n` +
        (summary ? `Reason: ${summary}\n` : "") +
        `\n- Hebrew -\n` +
        `נדרש אישור להפעלת הכלי ${tool}.${summary ? ` סיבה: ${summary}` : ""}`,
      link: e.metadata.conversationId
        ? `/conversations/${e.metadata.conversationId}`
        : "/approvals",
    };
  },

  "lead.created": (e) => {
    const name = safe(e.data.name, "Unnamed lead");
    const value = safe(e.data.valueEstimate, "");
    return {
      title: `New lead: ${name}`,
      body:
        `A new lead was created${value ? ` with estimated value ${value}` : ""}.\n` +
        `\n- Hebrew -\n` +
        `נוצר ליד חדש: ${name}${value ? ` (ערך משוער ${value})` : ""}.`,
      link: "/contacts",
    };
  },

  "meeting.scheduled": (e) => {
    const at = safe(e.data.startAt ?? e.data.scheduledFor, "");
    return {
      title: `Meeting scheduled${at ? ` for ${at}` : ""}`,
      body:
        `A meeting was successfully scheduled${at ? ` for ${at}` : ""}.\n` +
        `\n- Hebrew -\n` +
        `נקבעה פגישה${at ? ` ל-${at}` : ""}.`,
      link: e.metadata.conversationId
        ? `/conversations/${e.metadata.conversationId}`
        : undefined,
    };
  },

  "discount.applied": (e) => {
    const amount = safe(e.data.amount ?? e.data.percent, "");
    return {
      title: `Discount applied${amount ? `: ${amount}` : ""}`,
      body:
        `A discount was applied to a customer order.${amount ? ` Amount: ${amount}.` : ""}\n` +
        `\n- Hebrew -\n` +
        `הוחל הנחה${amount ? `: ${amount}` : ""}.`,
      link: e.metadata.conversationId ? `/conversations/${e.metadata.conversationId}` : undefined,
    };
  },

  "refund.issued": (e) => {
    const amount = safe(e.data.amount, "");
    return {
      title: `Refund issued${amount ? `: ${amount}` : ""}`,
      body:
        `A refund was issued.${amount ? ` Amount: ${amount}.` : ""}\n` +
        `\n- Hebrew -\n` +
        `הונפק החזר${amount ? ` בסך ${amount}` : ""}.`,
      link: e.metadata.conversationId ? `/conversations/${e.metadata.conversationId}` : undefined,
    };
  },

  "conversation.escalated": (e) => {
    const reason = safe(e.data.reason, "human handoff requested");
    return {
      title: `Conversation escalated`,
      body:
        `A conversation was escalated to a human. Reason: ${reason}.\n` +
        `\n- Hebrew -\n` +
        `שיחה הועברה לנציג אנושי. סיבה: ${reason}.`,
      link: e.metadata.conversationId ? `/conversations/${e.metadata.conversationId}` : undefined,
    };
  },

  "high_value_lead.detected": (e) => {
    const value = safe(e.data.valueEstimate, "high");
    const name = safe(e.data.name, "Unnamed lead");
    return {
      title: `High-value lead detected: ${name}`,
      body:
        `A high-value lead was detected (estimated ${value}).\n` +
        `\n- Hebrew -\n` +
        `זוהה ליד בעל ערך גבוה: ${name} (משוער ${value}).`,
      link: "/contacts",
    };
  },

  "payment.failed": (e) => {
    const reason = safe(e.data.reason, "");
    return {
      title: `Payment failed`,
      body:
        `A customer payment failed.${reason ? ` Reason: ${reason}.` : ""}\n` +
        `\n- Hebrew -\n` +
        `תשלום נכשל${reason ? `. סיבה: ${reason}` : ""}.`,
      link: e.metadata.conversationId ? `/conversations/${e.metadata.conversationId}` : undefined,
    };
  },

  "system.error.critical": (e) => {
    const msg = safe(e.data.message, "Unknown error");
    return {
      title: `Critical system error`,
      body:
        `A critical system error was reported: ${msg}\n` +
        `\n- Hebrew -\n` +
        `שגיאת מערכת קריטית: ${msg}.`,
      link: "/system/health",
    };
  },

  // ── Billing · subscription · AI Units ──────────────────────────────────────
  "subscription.trial_started": (e) => {
    const ends = safe(e.data.trialEndsAt, "");
    return {
      title: `Your free trial has started`,
      body: `Your 14-day trial is active${ends ? ` until ${ends}` : ""}. Your card will be charged automatically when it ends.\n\n- Hebrew -\nתקופת הניסיון בת 14 הימים החלה${ends ? ` עד ${ends}` : ""}.`,
      link: "/settings/billing",
    };
  },
  "subscription.trial_ending": (e) => {
    const ends = safe(e.data.trialEndsAt, "soon");
    return {
      title: `Your trial ends ${ends}`,
      body: `Your trial ends ${ends} and your first charge will run automatically.\n\n- Hebrew -\nתקופת הניסיון מסתיימת ${ends} והחיוב הראשון יבוצע אוטומטית.`,
      link: "/settings/billing",
    };
  },
  "subscription.activated": (e) => {
    const plan = safe(e.data.planKey, "");
    return {
      title: `Subscription active`,
      body: `Your ${plan} subscription is active.\n\n- Hebrew -\nהמנוי שלך פעיל${plan ? ` (${plan})` : ""}.`,
      link: "/settings/billing",
    };
  },
  "subscription.plan_changed": (e) => {
    const to = safe(e.data.to, "");
    const when = safe(e.data.when, "");
    return {
      title: `Plan change ${when === "immediate" ? "applied" : "scheduled"}`,
      body: `Your plan will change to ${to}${when === "period_end" ? " at the end of the current billing period" : " now"}.\n\n- Hebrew -\nתוכנית המנוי תשתנה ל-${to}.`,
      link: "/settings/billing",
    };
  },
  "subscription.canceled": (e) => {
    const at = safe(e.data.effectiveAt, "");
    return {
      title: `Subscription cancellation scheduled`,
      body: `Your subscription will end${at ? ` on ${at}` : " at the end of the current period"}. You can resume anytime before then.\n\n- Hebrew -\nהמנוי יסתיים${at ? ` בתאריך ${at}` : ""}. ניתן לחדש עד אז.`,
      link: "/settings/billing",
    };
  },
  "subscription.resumed": () => ({
    title: `Subscription resumed`,
    body: `Your subscription will continue as normal.\n\n- Hebrew -\nהמנוי שלך ימשיך כרגיל.`,
    link: "/settings/billing",
  }),
  "subscription.suspended": (e) => {
    const reason = safe(e.data.reason, "");
    return {
      title: `Subscription suspended`,
      body: `AI features are paused due to a billing issue${reason ? ` (${reason})` : ""}. Update your payment method to restore service.\n\n- Hebrew -\nהמנוי הושעה עקב בעיית תשלום. עדכנו את אמצעי התשלום כדי לחדש את השירות.`,
      link: "/settings/billing",
    };
  },
  "subscription.past_due": () => ({
    title: `Payment overdue`,
    body: `We couldn't renew your subscription. We'll retry shortly — please check your payment method.\n\n- Hebrew -\nלא הצלחנו לחדש את המנוי. נסו לעדכן את אמצעי התשלום.`,
    link: "/settings/billing",
  }),
  "invoice.issued": (e) => ({
    title: `New invoice`,
    body: `A new invoice was issued (${safe(e.data.amount, "")}).\n\n- Hebrew -\nהונפקה חשבונית חדשה.`,
    link: "/settings/billing/invoices",
  }),
  "invoice.paid": (e) => ({
    title: `Payment received`,
    body: `Your payment of ${safe(e.data.amount, "")} was received. Thank you!\n\n- Hebrew -\nהתשלום התקבל. תודה!`,
    link: "/settings/billing/invoices",
  }),
  "payment_method.expiring": (e) => ({
    title: `Card expiring soon`,
    body: `Your card ending ${safe(e.data.last4, "")} is expiring. Update it to avoid service interruption.\n\n- Hebrew -\nתוקף הכרטיס עומד לפוג. עדכנו אותו כדי למנוע הפסקת שירות.`,
    link: "/settings/billing",
  }),
  "credit.threshold": (e) => {
    const pct = safe(e.data.pct, "");
    return {
      title: `AI Units: ${pct}% used`,
      body: `You've used ${pct}% of your monthly AI Units. Buy more or enable auto-purchase to avoid interruption.\n\n- Hebrew -\nניצלתם ${pct}% מיחידות ה-AI החודשיות. ניתן לרכוש עוד או להפעיל רכישה אוטומטית.`,
      link: "/settings/billing/credits",
    };
  },
  "credit.exhausted": () => ({
    title: `AI Units exhausted`,
    body: `Your AI Units are used up. AI features are paused until you add more; the rest of the platform works normally.\n\n- Hebrew -\nיחידות ה-AI אזלו. תכונות ה-AI מושהות עד לרכישה נוספת; שאר המערכת פועלת כרגיל.`,
    link: "/settings/billing/credits",
  }),
  "credit.auto_purchase_succeeded": (e) => ({
    title: `Auto-purchase successful`,
    body: `${safe(e.data.units, "")} AI Units were added automatically.\n\n- Hebrew -\nנוספו יחידות AI אוטומטית.`,
    link: "/settings/billing/credits",
  }),
  "credit.auto_purchase_failed": () => ({
    title: `Auto-purchase failed`,
    body: `We couldn't auto-purchase AI Units. Please check your payment method.\n\n- Hebrew -\nרכישת ה-AI האוטומטית נכשלה. בדקו את אמצעי התשלום.`,
    link: "/settings/billing/credits",
  }),
  "credit.auto_purchase_ceiling_reached": (e) => ({
    title: `Auto-purchase monthly limit reached`,
    body: `Auto-purchase hit your monthly spend limit (${safe(e.data.ceiling, "")}). Buy AI Units manually to continue.\n\n- Hebrew -\nרכישה אוטומטית הגיעה לתקרת ההוצאה החודשית. ניתן לרכוש יחידות AI ידנית.`,
    link: "/settings/billing/credits",
  }),
};

export function renderTemplate(event: SystemEvent): RenderedTemplate {
  const fn = TEMPLATES[event.type];
  if (fn) return fn(event);
  // Fallback for unknown event types - shouldn't happen but stay safe.
  return {
    title: `Notification: ${event.type}`,
    body:
      `Event ${event.type} fired.\nData: ${safe(event.data, "{}")}.\n` +
      `\n- Hebrew -\n` +
      `התקבלה התראה: ${event.type}.`,
  };
}
