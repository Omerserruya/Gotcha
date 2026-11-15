/**
 * The templates GOTCHA's own WhatsApp number (the platform alerts number) may
 * send, as code. Moved here from services/notifications platform-whatsapp.ts
 * on 2026-11-15, unchanged, so the SYSTEM_ADMIN console routes in auth can
 * seed, validate and submit the same definitions notifications sends.
 *
 * ── These strings must match what is registered with Meta, exactly ──
 *
 * A template is approved by Meta under a name and a language, and the body is
 * fixed at approval time. `body` here is the submitted text. Since 2026-11-15
 * the console may edit a body (platform_whatsapp_templates.body); the value
 * here is the default the row is seeded with, and the name, parameter count,
 * buttons and category always come from here.
 */
export type TemplateLocale = "en" | "he";

/** The languages a platform notification can be sent in. */
export const TEMPLATE_LOCALES: readonly TemplateLocale[] = ["en", "he"];

export interface PlatformTemplate {
  /**
   * The name registered with Meta. Sent verbatim; a mismatch is a send failure,
   * not a fallback.
   */
  name: string;
  /**
   * The submitted body per language, with `{{1}}`-style placeholders.
   *
   * Kept here to be reviewable against the Meta console, and to make the
   * parameter count checkable rather than remembered.
   */
  body: Record<TemplateLocale, string>;
  /** How many body parameters the template takes, derived from the text. */
  parameterCount: number;
  /** A URL button whose dynamic suffix is a parameter (app.gotcha.co.il/inbox?c={{1}}). */
  urlButton?: boolean;
  /** Quick-reply buttons whose payloads are set per send (the approval refs). */
  quickReplies?: number;
}

/**
 * One template per notification event that may be delivered on WhatsApp.
 * Category UTILITY, languages he + en; the list submitted to Meta (2026-11-02).
 *
 * ★ KEYED BY EVENT TYPE ON PURPOSE. An event offered on the WhatsApp column
 * with no template here cannot be delivered outside the 24-hour window, so
 * `templateFor()` returning null is what a caller must check BEFORE offering
 * the channel - the same shape as a tool that must not be surfaced when it
 * cannot execute. Meta refuses a body that starts or ends with a variable.
 */
export const PLATFORM_TEMPLATES: Record<string, PlatformTemplate> = {
  // Sent by the approval sender (whatsapp-approval.service), with Approve /
  // Reject quick replies; never by the generic dispatcher.
  "tool.approval_required": {
    name: "gotcha_approval_request",
    body: {
      en: "An action is waiting for your approval in GOTCHA: {{1}}. Tap a button below, or open the app to review.",
      he: "פעולה ממתינה לאישור שלך ב-GOTCHA: {{1}}. אפשר לבחור בכפתור למטה, או לפתוח את האפליקציה כדי לבדוק.",
    },
    parameterCount: 1,
    quickReplies: 2,
  },
  "conversation.escalated": {
    name: "gotcha_conversation_escalated",
    body: {
      en: "A conversation was passed to a person in GOTCHA: {{1}}. It is waiting for a reply.",
      he: "שיחה הועברה לטיפול אנושי ב-GOTCHA: {{1}}. היא ממתינה למענה.",
    },
    parameterCount: 1,
    urlButton: true,
  },
  "tool.action_failed": {
    name: "gotcha_action_failed",
    body: {
      en: "An action your AI employee tried to take did not complete: {{1}}. Open GOTCHA to see what happened.",
      he: "פעולה שהעובד ה-AI שלכם ניסה לבצע לא הושלמה: {{1}}. היכנסו ל-GOTCHA כדי לראות מה קרה.",
    },
    parameterCount: 1,
  },
  "credit.threshold": {
    name: "gotcha_credit_low",
    body: {
      en: "You have used {{1}}% of your AI credit for this period. Open GOTCHA to review or top up.",
      he: "השתמשתם ב-{{1}}% מקרדיט ה-AI לתקופה הזו. היכנסו ל-GOTCHA כדי לבדוק או לטעון.",
    },
    parameterCount: 1,
  },
  "credit.exhausted": {
    name: "gotcha_credit_exhausted",
    body: {
      en: "Your AI credit for this period is used up, so your AI employees have stopped replying. Open GOTCHA to top up.",
      he: "קרדיט ה-AI לתקופה הזו נגמר, ולכן העובדים ה-AI הפסיקו לענות. היכנסו ל-GOTCHA כדי לטעון.",
    },
    // No parameter: the message is the same every time it fires, and a number
    // in it would only ever be 100.
    parameterCount: 0,
  },
  "conversation.waiting": {
    name: "gotcha_customer_waiting",
    body: {
      en: "A customer has been waiting {{1}} minutes for a reply on {{2}} in GOTCHA. Open the conversation to answer.",
      he: "לקוח ממתין כבר {{1}} דקות למענה ב-{{2}} ב-GOTCHA. פתחו את השיחה כדי לענות.",
    },
    parameterCount: 2,
    urlButton: true,
  },
};

/** High-risk approvals: review in GOTCHA, no one-tap buttons. */
export const APPROVAL_REVIEW_TEMPLATE: PlatformTemplate = {
  name: "gotcha_approval_required",
  body: {
    en: "An action is waiting for your approval in GOTCHA: {{1}}. Open the app to review and decide.",
    he: "פעולה ממתינה לאישור שלך ב-GOTCHA: {{1}}. פתחו את האפליקציה כדי לבדוק ולהחליט.",
  },
  parameterCount: 1,
};

/**
 * The opt-in code (category AUTHENTICATION). Meta fixes the body for this
 * category; we send the code as the body parameter and as the copy-code
 * button's parameter.
 */
export const VERIFICATION_TEMPLATE_NAME = "gotcha_verification_code";

/** The high-risk approval variant's key in the platform template rows. */
export const APPROVAL_REVIEW_EVENT = "tool.approval_required.review";
/** The opt-in code's key in the platform template rows. */
export const VERIFICATION_EVENT = "verification";

/**
 * Meta's fixed AUTHENTICATION body, per language, for display only. Meta
 * writes this text; we submit only the options (security note, code expiry,
 * copy-code button), so it can never be edited.
 */
export const VERIFICATION_TEMPLATE_BODY: Record<TemplateLocale, string> = {
  en: "{{1}} is your verification code. For your security, do not share this code.",
  he: "{{1}} הוא קוד האימות שלך. למען אבטחתך, אין לשתף את הקוד הזה.",
};

export type PlatformTemplateCategory = "UTILITY" | "AUTHENTICATION";

/** One platform template as the console and the send path both see it. */
export interface PlatformTemplateDefinition {
  /** The row key: an alert event type, APPROVAL_REVIEW_EVENT or VERIFICATION_EVENT. */
  eventType: string;
  name: string;
  category: PlatformTemplateCategory;
  parameterCount: number;
  buttons: { url: boolean; quickReplies: number; copyCode: boolean };
  /** The default body per language (the code value). */
  body: Record<TemplateLocale, string>;
  /** Whether the console shows an on/off switch for it. */
  toggleable: boolean;
  /** The alert whose switch governs it (itself, or tool.approval_required for the review variant; null for verification). */
  governedBy: string | null;
  /** Whether the console may edit the body. AUTHENTICATION bodies are Meta's. */
  editable: boolean;
}

/** All eight, in the console's order. */
export function platformTemplateCatalogue(): PlatformTemplateDefinition[] {
  const alerts = Object.entries(PLATFORM_TEMPLATES).map(([eventType, t]): PlatformTemplateDefinition => ({
    eventType,
    name: t.name,
    category: "UTILITY",
    parameterCount: t.parameterCount,
    buttons: { url: !!t.urlButton, quickReplies: t.quickReplies ?? 0, copyCode: false },
    body: { ...t.body },
    toggleable: true,
    governedBy: eventType,
    editable: true,
  }));
  const at = alerts.findIndex((d) => d.eventType === "tool.approval_required");
  alerts.splice(at + 1, 0, {
    eventType: APPROVAL_REVIEW_EVENT,
    name: APPROVAL_REVIEW_TEMPLATE.name,
    category: "UTILITY",
    parameterCount: APPROVAL_REVIEW_TEMPLATE.parameterCount,
    buttons: { url: false, quickReplies: 0, copyCode: false },
    body: { ...APPROVAL_REVIEW_TEMPLATE.body },
    toggleable: false,
    governedBy: "tool.approval_required",
    editable: true,
  });
  alerts.push({
    eventType: VERIFICATION_EVENT,
    name: VERIFICATION_TEMPLATE_NAME,
    category: "AUTHENTICATION",
    parameterCount: 1,
    buttons: { url: false, quickReplies: 0, copyCode: true },
    body: { ...VERIFICATION_TEMPLATE_BODY },
    toggleable: false,
    governedBy: null,
    editable: false,
  });
  return alerts;
}

export function platformTemplateDefinition(eventType: string): PlatformTemplateDefinition | null {
  return platformTemplateCatalogue().find((d) => d.eventType === eventType) ?? null;
}
