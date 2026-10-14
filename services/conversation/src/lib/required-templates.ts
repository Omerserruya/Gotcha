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
 *
 * missed_call (B1, 2026-10-14) is required only while it is in use: a voice
 * number that forwards calls to an agent's phone (FORWARD_TO_AGENT) and calls
 * back agent-first (AGENT_FIRST). A missed call then messages that AGENT (not
 * a customer) with a button that rings them and bridges the caller. Its name
 * is fixed because voice-copilot sends it by name. It used to be created at
 * Meta automatically when the routing was saved, in English only and with no
 * person approving it; now it is a draft here like the others.
 */
export type RequiredRole = "reopen" | "followup" | "missed_call";
export type TemplateLanguage = "he" | "en";

interface Suggestion {
  body: string;
  button: string | null;
  sample: string;
}

interface RequiredTemplate {
  name: string;
  category: "UTILITY";
  /** QUICK_REPLY, or a URL button whose {{1}} suffix the sender fills per message. */
  buttonKind?: "QUICK_REPLY" | "URL";
  /** Required only while the feature that sends it is in use. */
  when?: "voice_missed_call";
  text: Record<TemplateLanguage, Suggestion>;
}

/** The voice service's callback path the missed-call button opens, {{1}} = a signed token. */
export const MISSED_CALL_CALLBACK_PATH = "/api/voice-copilot/callbacks/click/";

export const REQUIRED_TEMPLATES: Record<RequiredRole, RequiredTemplate> = {
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
  missed_call: {
    name: "missed_call_callback",
    category: "UTILITY",
    buttonKind: "URL",
    when: "voice_missed_call",
    text: {
      he: { body: "{{1}} ניסה ליצור איתך קשר. אפשר להתקשר בחזרה בלחיצה למטה: קודם יצלצל הטלפון שלך.", button: "להתקשר בחזרה", sample: "דנה כהן" },
      en: { body: "{{1}} tried to reach you. Tap below to call them back: we'll ring your phone first.", button: "Call them back", sample: "Dana Cohen" },
    },
  },
};

export const REQUIRED_ROLES = Object.keys(REQUIRED_TEMPLATES) as RequiredRole[];

export function roleOfTemplateName(name: string): RequiredRole | null {
  return REQUIRED_ROLES.find((r) => REQUIRED_TEMPLATES[r].name === name) ?? null;
}

/** The roles required for a workspace: the unconditional ones, and the conditional ones in use. */
export function requiredRolesFor(inUse: { voiceMissedCall: boolean }): RequiredRole[] {
  return REQUIRED_ROLES.filter((r) => {
    const when = REQUIRED_TEMPLATES[r].when;
    return !when || (when === "voice_missed_call" && inUse.voiceMissedCall);
  });
}

/** The voice modes under which a missed call messages the agent (and so needs the template). */
export function isMissedCallMode(v: { inboundMode?: string | null; outboundMode?: string | null }): boolean {
  return v.inboundMode === "FORWARD_TO_AGENT" && v.outboundMode === "AGENT_FIRST";
}

/**
 * The fields of a MessageTemplate draft for a role, from the suggestion or the
 * person's edit. A URL-button role needs `voiceOrigin`, the public voice
 * address the button opens; its URL is fixed (only the text can be edited)
 * because the sender fills exactly its {{1}} suffix.
 */
export function draftFields(role: RequiredRole, language: TemplateLanguage, edit?: { body?: string; button?: string | null }, voiceOrigin?: string) {
  const def = REQUIRED_TEMPLATES[role];
  const s = def.text[language];
  const body = (edit?.body ?? s.body).trim();
  // A URL button cannot be removed: the template exists for it.
  const button = def.buttonKind === "URL" ? (edit?.button || s.button) : edit?.button === undefined ? s.button : edit.button;
  let buttons: any[] = [];
  if (button && def.buttonKind === "URL") {
    if (!voiceOrigin) throw new Error("voiceOrigin is required for a URL-button template");
    const base = voiceOrigin.replace(/\/+$/, "") + MISSED_CALL_CALLBACK_PATH;
    buttons = [{ type: "URL", text: button.slice(0, 25), url: `${base}{{1}}`, example: `${base}examplepayload.examplesignature` }];
  } else if (button) {
    buttons = [{ type: "QUICK_REPLY", text: button.slice(0, 25) }];
  }
  return {
    name: REQUIRED_TEMPLATES[role].name,
    category: REQUIRED_TEMPLATES[role].category,
    language,
    channel: "WHATSAPP" as const,
    body,
    buttons,
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
