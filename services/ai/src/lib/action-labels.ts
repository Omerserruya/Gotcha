/**
 * An action, said in words to the person who would approve or run it.
 *
 * One table for the plan steps (assistant-plan) and the Copilot's proposed
 * actions (a quick_action in the suggestion list). The Copilot used to print
 * the tool's own name with its raw arguments ("link customer identifier -
 * type: phone, value: 97254...", 2026-10-29): a slug and a customer's phone
 * number, drawn as one of the ways to answer. A label never carries argument
 * values, and a tool without one gets a neutral line, never its name.
 */

export type ActionLocale = "he" | "en";

export const ACTION_LABELS: Record<string, Record<ActionLocale, string>> = {
  send_message: { he: "לשלוח הודעה", en: "Send a message" },
  tag_contact: { he: "לתייג", en: "Tag" },
  schedule_followup: { he: "לתזמן הודעת המשך", en: "Schedule a follow-up" },
  schedule_meeting: { he: "לקבוע פגישה", en: "Book a meeting" },
  create_broadcast: { he: "ליצור קמפיין", en: "Create a campaign" },
  schedule_broadcast: { he: "לתזמן קמפיין", en: "Schedule a campaign" },
  create_workflow: { he: "ליצור אוטומציה", en: "Create an automation" },
  resolve_identity: { he: "לזהות את הלקוח", en: "Identify the customer" },
  merge_contacts: { he: "למזג את פרטי הלקוח", en: "Merge the customer's records" },
  link_customer_identifier: { he: "לקשר פרט מזהה ללקוח", en: "Link an identifier to the customer" },
  escalate_to_human: { he: "להעביר לנציג", en: "Hand over to a person" },
  close_conversation: { he: "לסגור את השיחה", en: "Close the conversation" },
  update_contact: { he: "לעדכן את פרטי הלקוח", en: "Update the customer's details" },
  create_task: { he: "ליצור משימה", en: "Create a task" },
};

const GENERIC: Record<ActionLocale, string> = {
  he: "פעולה מוצעת במערכת",
  en: "A suggested action in the system",
};

/** "he" for Hebrew, else English: the two languages the labels are written in. */
export function actionLocale(locale?: string | null): ActionLocale {
  return typeof locale === "string" && locale.trim().toLowerCase().startsWith("he") ? "he" : "en";
}

/** The label for a tool (dotted or integration_ names included), or null when there is none. */
export function actionLabel(tool: string, locale: ActionLocale): string | null {
  const bare = tool.startsWith("integration_") ? tool.slice("integration_".length) : tool;
  const last = bare.includes(".") ? bare.slice(bare.lastIndexOf(".") + 1) : bare;
  return ACTION_LABELS[tool]?.[locale] ?? ACTION_LABELS[bare]?.[locale] ?? ACTION_LABELS[last]?.[locale] ?? null;
}

/** What the agent reads for a proposed action: its label, else the neutral line. Never a slug, never an argument. */
export function quickActionText(tool: string, locale?: string | null): string {
  const l = actionLocale(locale);
  return actionLabel(tool, l) ?? GENERIC[l];
}
