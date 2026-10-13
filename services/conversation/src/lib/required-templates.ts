/**
 * The WhatsApp templates every number needs (B9, 2026-10-13).
 *
 * Past the 24h customer-service window WhatsApp accepts only an approved
 * template. Two situations hit it in every workspace:
 *  - reopen: answering a customer who wrote more than a day ago;
 *  - followup: the idle reminder when the customer went quiet for over a day.
 *
 * The role is the template's name (gotcha_reopen, gotcha_followup), so it
 * needs no column. The text is a suggestion: the person approves or edits it
 * before it is submitted to Meta. UTILITY, because both continue a
 * conversation the customer started.
 */
export type RequiredRole = "reopen" | "followup";
export type TemplateLanguage = "he" | "en";

interface Suggestion {
  body: string;
  button: string | null;
  sample: string;
}

export const REQUIRED_TEMPLATES: Record<RequiredRole, { name: string; category: "UTILITY"; text: Record<TemplateLanguage, Suggestion> }> = {
  reopen: {
    name: "gotcha_reopen",
    category: "UTILITY",
    text: {
      he: { body: "היי {{1}}, יש לנו תשובה להודעה שלך. אפשר להמשיך את השיחה כאן.", button: "להמשך השיחה", sample: "דנה" },
      en: { body: "Hi {{1}}, we have a reply to your message. You can continue the conversation here.", button: "Continue", sample: "Dana" },
    },
  },
  followup: {
    name: "gotcha_followup",
    category: "UTILITY",
    text: {
      he: { body: "היי {{1}}, לא שמענו ממך. אפשר לענות כאן מתי שנוח לך.", button: null, sample: "דנה" },
      en: { body: "Hi {{1}}, we didn't hear back from you. Reply here whenever it suits you.", button: null, sample: "Dana" },
    },
  },
};

export const REQUIRED_ROLES = Object.keys(REQUIRED_TEMPLATES) as RequiredRole[];

export function roleOfTemplateName(name: string): RequiredRole | null {
  return REQUIRED_ROLES.find((r) => REQUIRED_TEMPLATES[r].name === name) ?? null;
}

/** The fields of a MessageTemplate draft for a role, from the suggestion or the person's edit. */
export function draftFields(role: RequiredRole, language: TemplateLanguage, edit?: { body?: string; button?: string | null }) {
  const s = REQUIRED_TEMPLATES[role].text[language];
  const body = (edit?.body ?? s.body).trim();
  const button = edit?.button === undefined ? s.button : edit.button;
  return {
    name: REQUIRED_TEMPLATES[role].name,
    category: REQUIRED_TEMPLATES[role].category,
    language,
    channel: "WHATSAPP" as const,
    body,
    buttons: button ? [{ type: "QUICK_REPLY", text: button.slice(0, 25) }] : [],
    variables: /\{\{\s*1\s*\}\}/.test(body) ? [{ key: "1", sample: s.sample }] : [],
  };
}

export type RequiredState = "missing" | "draft" | "pending" | "approved" | "rejected";

export function stateOf(template: { status: string } | null | undefined): RequiredState {
  if (!template) return "missing";
  switch (template.status) {
    case "APPROVED": return "approved";
    case "PENDING_APPROVAL": return "pending";
    case "REJECTED": return "rejected";
    default: return "draft";
  }
}

/** The languages a workspace's required templates are made in: its system language. */
export function languagesFor(defaultLocale: string | null | undefined): TemplateLanguage[] {
  return String(defaultLocale ?? "").toLowerCase().startsWith("he") ? ["he"] : ["en"];
}
