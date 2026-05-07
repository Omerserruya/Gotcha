/**
 * Notification templates per SystemEventType.
 *
 * Templates render to a {title, body} pair used both for in-app rows and
 * the email subject + body. Bilingual (EN/HE) — we tag both in the same
 * payload, separated by a divider, mirroring the dashboard's i18n convention.
 *
 * Templates are pure functions of `event.data` — no I/O. The dispatcher
 * passes `event.data` straight through; missing fields show "n/a".
 */

import type { SystemEvent, SystemEventType } from "./event-emitter.service";

export interface RenderedTemplate {
  /** Short, used as in-app `title` and email `subject`. */
  title: string;
  /** Plain-text body. The email worker wraps this in HTML. */
  body: string;
  /** Optional dashboard link — used as `link` on the InAppNotification row. */
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
        `\n— Hebrew —\n` +
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
        `\n— Hebrew —\n` +
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
        `\n— Hebrew —\n` +
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
        `\n— Hebrew —\n` +
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
        `\n— Hebrew —\n` +
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
        `\n— Hebrew —\n` +
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
        `\n— Hebrew —\n` +
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
        `\n— Hebrew —\n` +
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
        `\n— Hebrew —\n` +
        `שגיאת מערכת קריטית: ${msg}.`,
      link: "/system/health",
    };
  },
};

export function renderTemplate(event: SystemEvent): RenderedTemplate {
  const fn = TEMPLATES[event.type];
  if (fn) return fn(event);
  // Fallback for unknown event types — shouldn't happen but stay safe.
  return {
    title: `Notification: ${event.type}`,
    body:
      `Event ${event.type} fired.\nData: ${safe(event.data, "{}")}.\n` +
      `\n— Hebrew —\n` +
      `התקבלה התראה: ${event.type}.`,
  };
}
