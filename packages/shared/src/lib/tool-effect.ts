/**
 * Does a tool READ or does it CHANGE something?
 *
 * This lived in services/ai (capabilities.ts) where the Copilot used it to
 * decide who executes a tool. It moved here because a second consumer needs
 * exactly the same answer: the sandbox gate in `dispatchToolCall`, which lets
 * reads run against real tenant data but must never let a write fire during a
 * test conversation. Two copies of this judgement would eventually disagree,
 * and the disagreement would show up as a test chat that really did refund
 * someone. capabilities.ts now re-exports this, so there is one table.
 *
 * Classification is by naming convention plus a small known-tool table, biased
 * to SAFETY: anything ambiguous or unrecognised is treated as an action. The
 * cost of misclassifying a read as an action is a needlessly simulated result;
 * the cost of the reverse is a real side effect on a customer's account.
 */

export type ToolEffect = "read" | "action";

const KNOWN_READ_TOOLS = new Set<string>([
  "check_availability",
  "get_contact",
  "resolve_identity",
  "list_recent_messages",
  "get_conversation",
  "list_workflows",
  "preview_broadcast",
]);

const KNOWN_ACTION_TOOLS = new Set<string>([
  "schedule_meeting", "reschedule_meeting", "cancel_meeting",
  "integration_create_lead", "integration_create_contact", "integration_create_deal",
  "create_task", "create_ticket", "update_contact", "update_crm", "tag_contact",
  "merge_contacts", "link_customer_identifier", "send_message",
  "schedule_followup", "schedule_followup_template", "generate_followup",
  "create_broadcast", "schedule_broadcast", "create_workflow",
  "issue_refund", "refund", "apply_discount", "close_conversation", "escalate_to_human",
]);

// Verb at a name boundary (`get_x`, `hubspot.search_y`, `x.list`). ACTION is
// checked FIRST: a name that carries any mutating verb is an action even if it
// also reads (e.g. `get_or_create`).
const ACTION_VERB_RE =
  /(^|[._])(create|update|delete|remove|send|schedule|book|reschedule|cancel|refund|issue|charge|pay|merge|close|escalate|tag|link|apply|assign|move|convert|generate|post|set|sync|upsert)([._]|$)/i;
const READ_VERB_RE =
  /(^|[._])(get|list|search|find|lookup|read|fetch|describe|retrieve|check|view|query|resolve|preview|count|history)([._]|$)/i;

/**
 * Classify a tool by execution effect. Pure; never throws. Safe-biased:
 * unknown or ambiguous tools resolve to "action".
 */
export function classifyToolEffect(name: string): ToolEffect {
  // `submit_suggestions` is the Copilot's terminator - it returns output, it
  // does not touch anything - so it is genuinely a read.
  if (name === "submit_suggestions") return "read";
  // An EMPTY or missing name used to fall into that same branch and come back
  // as "read". That was harmless while the only consumer was the Copilot's
  // who-executes decision, but the sandbox write guard now asks the same
  // question to decide whether something may really run, and "unnamed
  // therefore safe" is the wrong default. An unrecognised name is an action,
  // exactly as this module's contract says.
  if (!name) return "action";
  if (KNOWN_ACTION_TOOLS.has(name)) return "action";
  if (KNOWN_READ_TOOLS.has(name)) return "read";
  if (ACTION_VERB_RE.test(name)) return "action";
  if (READ_VERB_RE.test(name)) return "read";
  return "action";
}
