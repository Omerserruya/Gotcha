/**
 * Human names for tools.
 *
 * A permission screen that labels a row `list_recent_messages` is asking the
 * reader to parse an identifier before they can decide whether an AI may run
 * it. The identifier is for us; the label is for them. Raw ids stay available
 * behind the diagnostics toggle.
 *
 * GOTCHA's own tools are a fixed set we own, so they get real translations.
 * Third-party catalog tools carry a provider-written name ("List Orders"),
 * which is already human - `humanizeToolName` only rescues the ones that are
 * still a slug.
 */

/** Tool names GOTCHA itself owns, in both locales. */
const INTERNAL_TOOL_NAMES: Record<string, { en: string; he: string }> = {
  get_conversation: { en: "Get conversation", he: "שליפת שיחה" },
  list_recent_messages: { en: "List recent messages", he: "הצגת הודעות אחרונות" },
  get_contact: { en: "Get contact", he: "שליפת איש קשר" },
  resolve_identity: { en: "Resolve identity", he: "זיהוי לקוח" },
  list_workflows: { en: "List workflows", he: "הצגת תהליכים" },
  preview_broadcast: { en: "Preview broadcast", he: "תצוגה מקדימה של דיוור" },
  send_message: { en: "Send message", he: "שליחת הודעה" },
  close_conversation: { en: "Close conversation", he: "סגירת שיחה" },
  escalate_to_human: { en: "Escalate to a person", he: "העברה לנציג אנושי" },
  generate_followup: { en: "Draft a follow-up", he: "ניסוח מעקב" },
  schedule_followup: { en: "Schedule a follow-up", he: "תזמון מעקב" },
  schedule_followup_template: { en: "Schedule a follow-up from a template", he: "תזמון מעקב מתבנית" },
  schedule_meeting: { en: "Schedule a meeting", he: "קביעת פגישה" },
  create_task: { en: "Create task", he: "יצירת משימה" },
  create_ticket: { en: "Create ticket", he: "פתיחת פנייה" },
  create_workflow: { en: "Create workflow", he: "יצירת תהליך" },
  create_broadcast: { en: "Create broadcast", he: "יצירת דיוור" },
  schedule_broadcast: { en: "Schedule broadcast", he: "תזמון דיוור" },
  update_contact: { en: "Update contact", he: "עדכון איש קשר" },
  update_crm: { en: "Update CRM", he: "עדכון CRM" },
  tag_contact: { en: "Tag contact", he: "תיוג איש קשר" },
  merge_contacts: { en: "Merge contacts", he: "מיזוג אנשי קשר" },
  link_customer_identifier: { en: "Link a customer identifier", he: "קישור מזהה לקוח" },
};

/** Words that must not be sentence-cased into "Crm" / "Api". */
const ACRONYMS = new Set(["crm", "api", "sms", "url", "id", "ai", "faq", "sla", "vip", "rds", "db"]);

/** True when a label is still a machine identifier rather than a name. */
export function looksLikeRawToolId(label: string): boolean {
  return /[._]/.test(label) || (label === label.toLowerCase() && /^[a-z0-9]+$/.test(label));
}

/**
 * "shopify.get_order" → "Get order". Sentence case, not Title Case: a row of
 * Title Case labels reads as headings and fights the group heading above it.
 */
export function humanizeToolName(rawName: string): string {
  const bare = String(rawName || "").split(".").pop() ?? "";
  const words = bare.split(/[_\s]+/).filter(Boolean);
  if (!words.length) return rawName;
  return words
    .map((w, i) => {
      if (ACRONYMS.has(w.toLowerCase())) return w.toUpperCase();
      if (i === 0) return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
      return w.toLowerCase();
    })
    .join(" ");
}

/**
 * The label to show for a tool.
 *
 * `providedName` is the catalog's own name when it has one. It wins, unless it
 * is itself a slug - a seeded row whose name was never written should not put
 * `get_order` in front of a reader just because it technically has a value.
 */
export function toolDisplayName(
  rawName: string,
  providedName?: string | null,
  locale: "en" | "he" = "en",
): string {
  const bare = String(rawName || "").split(".").pop() ?? "";
  const internal = INTERNAL_TOOL_NAMES[bare];
  if (internal) return locale === "he" ? internal.he : internal.en;

  const provided = (providedName ?? "").trim();
  if (provided && !looksLikeRawToolId(provided)) return provided;

  return humanizeToolName(rawName);
}

export const __testables = { INTERNAL_TOOL_NAMES };
