/**
 * Capability Layer.
 *
 * Humans think in CAPABILITIES, not tools: "I can schedule things", "I can look
 * up the customer", "I can take a payment". The runtime should present the model
 * the same way — a capability, its purpose, and the tools under it — instead of a
 * flat tool list.
 *
 * This layer is COMPLETELY GENERIC and role-agnostic. A tool's capability is
 * DERIVED from existing metadata:
 *   1. Integration tools (`integration.<slug>`, `<provider>.<tool>`, `custom*.*`)
 *      → the `Integration.category` the orchestrator already knows (passed as a
 *      `hints` map: toolName → category). New integrations/categories appear
 *      automatically, with no change here.
 *   2. Platform built-ins (check_availability, schedule_meeting, escalate_to_human,
 *      …) → a small declarative table below, keyed to the SAME canonical names as
 *      `IntegrationCategory` so a built-in and an integration tool in the same
 *      domain land in ONE group.
 *
 * Nothing here is sales/SDR/support-specific. Capabilities are platform primitives
 * + tenant integrations; they work for every current and future employee.
 */

export interface CapabilityTool {
  name: string;
  /** Optional one-liner shown next to the tool (built-ins only; integrations show the name). */
  summary?: string;
}

export interface CapabilityGroup {
  /** Canonical key (aligned to IntegrationCategory, e.g. "CALENDAR", "CRM"). */
  capability: string;
  /** Human label for the prompt (e.g. "Scheduling & meetings"). */
  label: string;
  /** What this capability is FOR — one sentence. */
  purpose: string;
  tools: CapabilityTool[];
}

// Built-in platform tools → canonical capability key (mirrors IntegrationCategory).
// Generic primitives only. Integration tools are grouped via `hints`, not here.
const BUILTIN_TOOL_CAPABILITY: Record<string, string> = {
  // Scheduling / calendar
  check_availability: "CALENDAR",
  schedule_meeting: "CALENDAR",
  reschedule_meeting: "CALENDAR",
  cancel_meeting: "CALENDAR",
  // Customer records (CRM)
  integration_create_lead: "CRM",
  integration_create_contact: "CRM",
  integration_create_deal: "CRM",
  link_customer_identifier: "CRM",
  update_contact: "CRM",
  update_crm: "CRM",
  tag_contact: "CRM",
  merge_contacts: "CRM",
  // Tasks / workflows
  create_task: "PROJECT_MANAGEMENT",
  create_workflow: "PROJECT_MANAGEMENT",
  // Messaging / follow-ups / broadcasts
  schedule_followup: "COMMUNICATION",
  schedule_followup_template: "COMMUNICATION",
  generate_followup: "COMMUNICATION",
  send_message: "COMMUNICATION",
  create_broadcast: "COMMUNICATION",
  schedule_broadcast: "COMMUNICATION",
  // Support
  create_ticket: "HELPDESK",
  // Billing
  issue_refund: "PAYMENTS",
  refund: "PAYMENTS",
  apply_discount: "PAYMENTS",
  // Conversation control (no integration analogue → its own group)
  escalate_to_human: "CONVERSATION",
  close_conversation: "CONVERSATION",
};

// Short, human summaries for built-ins. Integration tools intentionally show only
// their name (their description isn't available in the pure prompt builder).
const BUILTIN_TOOL_SUMMARY: Record<string, string> = {
  check_availability: "see real open times / working hours",
  schedule_meeting: "book a time the customer chose",
  reschedule_meeting: "move an existing meeting",
  cancel_meeting: "cancel an existing meeting",
  integration_create_lead: "record a new lead",
  integration_create_contact: "record a new contact",
  integration_create_deal: "open a deal / opportunity",
  link_customer_identifier: "link an email/phone to the record",
  create_task: "create a task for the team",
  schedule_followup: "schedule a follow-up message",
  schedule_followup_template: "schedule a templated follow-up",
  escalate_to_human: "hand off to a human",
  close_conversation: "mark the conversation resolved",
};

const CAPABILITY_LABEL: Record<string, string> = {
  CALENDAR: "Scheduling & meetings",
  CRM: "Customer records",
  COMMUNICATION: "Messaging & follow-ups",
  PROJECT_MANAGEMENT: "Tasks & workflows",
  HELPDESK: "Support tickets",
  PAYMENTS: "Billing",
  ECOMMERCE: "Store & orders",
  SHIPPING: "Shipping & fulfillment",
  ANALYTICS: "Reports",
  DATABASE: "Data lookups",
  CONVERSATION: "Conversation control",
  CUSTOM: "Custom actions",
  OTHER: "Other actions",
};

const CAPABILITY_PURPOSE: Record<string, string> = {
  CALENDAR: "Check real availability, then book / move / cancel meetings.",
  CRM: "Find and record the customer, leads, deals, and updates.",
  COMMUNICATION: "Send messages, follow-ups, and broadcasts.",
  PROJECT_MANAGEMENT: "Create tasks and workflows for the team.",
  HELPDESK: "Look up and manage support tickets.",
  PAYMENTS: "Refunds, discounts, and billing actions.",
  ECOMMERCE: "Orders, products, and store operations.",
  SHIPPING: "Shipments and fulfillment.",
  ANALYTICS: "Reports and metrics.",
  DATABASE: "Custom data lookups.",
  CONVERSATION: "Hand off to a human or close the conversation.",
  CUSTOM: "Tenant-defined custom actions.",
  OTHER: "Other available actions.",
};

// Deterministic group order so the prompt is stable across turns (the block is in
// the non-cached turn section, so this is for determinism/tests, not cache). Any
// capability not listed sorts alphabetically AFTER these.
const CAPABILITY_ORDER = [
  "CALENDAR",
  "CRM",
  "COMMUNICATION",
  "PROJECT_MANAGEMENT",
  "HELPDESK",
  "PAYMENTS",
  "ECOMMERCE",
  "SHIPPING",
  "ANALYTICS",
  "DATABASE",
  "CONVERSATION",
  "CUSTOM",
  "OTHER",
];

// A business outcome needs a capability to be producible. The Goal Evaluator asks
// this to decide FAILED(missing_capability) — keeping the outcome→capability
// mapping in the Capability Layer (its owner), not in the evaluator. Generic:
// extend alongside new BusinessOutcome values.
const OUTCOME_CAPABILITY: Record<string, string> = {
  booking: "CALENDAR",
  crm_lead: "CRM",
  crm_contact: "CRM",
  crm_deal: "CRM",
  quote: "CRM",
  ticket: "HELPDESK",
  order: "ECOMMERCE",
};

/**
 * The capability a given business outcome requires to be produced this
 * conversation (e.g. `booking → CALENDAR`). Returns null when the outcome needs
 * no special capability. Pure lookup; never throws.
 */
export function capabilityForOutcome(outcome: string): string | null {
  return OUTCOME_CAPABILITY[outcome] ?? null;
}

/**
 * Resolve the canonical capability key for one tool. Order: explicit hint
 * (Integration.category) → built-in table → structural fallback (dotted /
 * integration_ tools with no hint → CUSTOM) → OTHER.
 */
export function capabilityOfTool(name: string, hints?: Record<string, string>): string {
  if (!name) return "OTHER";
  const hint = hints?.[name];
  if (hint && hint.trim()) return hint.trim().toUpperCase();
  const builtin = BUILTIN_TOOL_CAPABILITY[name];
  if (builtin) return builtin;
  if (name.startsWith("custom.") || name.startsWith("custom_db.")) return "CUSTOM";
  // Dotted adapter tool or integration_* wrapper we have no category for.
  if (name.includes(".") || name.startsWith("integration_") || name.startsWith("integration.")) return "CUSTOM";
  return "OTHER";
}

/**
 * A tool's EXECUTION EFFECT, independent of role:
 *   - "read"   : a safe, side-effect-free retrieval (search/get/list/check/…).
 *   - "action" : a customer-facing or state-mutating operation (book/create/
 *                refund/send/update/…).
 *
 * This is the primitive the AI Copilot uses to decide WHO executes: it may
 * auto-run "read" tools in the background to enrich a recommendation, but it
 * must only RECOMMEND "action" tools to the human (never fire them). The AI
 * Employee ignores this split (it executes both) — same brain, different mode.
 *
 * Classification is by naming convention + a small known-tool table, biased to
 * SAFETY: anything ambiguous or unrecognized is treated as "action" so the
 * Copilot never auto-executes something customer-facing by mistake.
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
 * Classify a tool by execution effect. Pure; never throws. Safe-biased: unknown
 * or ambiguous tools resolve to "action" (the Copilot will recommend, not run).
 */
export function classifyToolEffect(name: string): ToolEffect {
  if (!name || name === "submit_suggestions") return "read";
  if (KNOWN_ACTION_TOOLS.has(name)) return "action";
  if (KNOWN_READ_TOOLS.has(name)) return "read";
  if (ACTION_VERB_RE.test(name)) return "action";
  if (READ_VERB_RE.test(name)) return "read";
  return "action";
}

/** How the Copilot may run a tool this turn (the EXECUTION-ELIGIBILITY decision). */
export type CopilotExecutionMode = "background" | "recommended" | "none";

export interface CopilotToolRouting {
  /** Effect classification (read = safe retrieval, action = state-mutating). */
  effect: ToolEffect;
  /** Does the Copilot auto-execute this tool itself? Only safe reads do. */
  execute: boolean;
  /**
   * - `background`  : auto-run silently to enrich the recommendation (reads).
   * - `recommended` : surfaced to the human as a recommended action, NOT run.
   * - `none`        : terminator / non-executing (submit_suggestions).
   */
  executionMode: CopilotExecutionMode;
}

/**
 * The SINGLE source of truth for Copilot execution eligibility, derived purely
 * from `classifyToolEffect`. Both Copilot paths (suggestResponse + chatWithAgent)
 * route EVERY model-invoked tool through this — so "who executes" can never drift
 * between the two entry points. The AI Employee ignores this split (it executes
 * everything); same brain, different mode.
 *
 *   - `submit_suggestions` → terminator, never executes (executionMode "none").
 *   - a READ tool          → the Copilot auto-runs it in the background.
 *   - an ACTION tool       → the Copilot recommends it to the human, never runs it.
 *
 * Pure; never throws.
 */
export function routeCopilotTool(name: string): CopilotToolRouting {
  if (!name || name === "submit_suggestions") {
    return { effect: "read", execute: false, executionMode: "none" };
  }
  const effect = classifyToolEffect(name);
  return effect === "read"
    ? { effect, execute: true, executionMode: "background" }
    : { effect, execute: false, executionMode: "recommended" };
}

/**
 * Group a turn's tool surface into capabilities. Pure, deterministic, never throws.
 * `hints` maps an integration tool name → its Integration.category (CRM, CALENDAR…)
 * — the orchestrator already has this when it builds the surface.
 */
export function groupToolsIntoCapabilities(
  toolFunctionNames: string[],
  hints?: Record<string, string>,
): CapabilityGroup[] {
  const groups = new Map<string, CapabilityGroup>();
  for (const name of toolFunctionNames ?? []) {
    if (!name || name === "submit_suggestions") continue;
    const cap = capabilityOfTool(name, hints);
    let g = groups.get(cap);
    if (!g) {
      g = {
        capability: cap,
        label: CAPABILITY_LABEL[cap] ?? cap,
        purpose: CAPABILITY_PURPOSE[cap] ?? cap,
        tools: [],
      };
      groups.set(cap, g);
    }
    if (!g.tools.some((t) => t.name === name)) {
      g.tools.push({ name, summary: BUILTIN_TOOL_SUMMARY[name] });
    }
  }
  const ordered: CapabilityGroup[] = [];
  for (const cap of CAPABILITY_ORDER) {
    const g = groups.get(cap);
    if (g) {
      ordered.push(g);
      groups.delete(cap);
    }
  }
  for (const cap of [...groups.keys()].sort()) ordered.push(groups.get(cap)!);
  return ordered;
}

/**
 * Render capability groups for the prompt — Capability → Purpose → tools, instead
 * of a flat list. Returns null when there are no tools.
 */
export function renderCapabilities(groups: CapabilityGroup[]): string | null {
  if (!groups.length) return null;
  const lines: string[] = [
    "**Capabilities you have this turn** (think in capabilities, then pick the tool that fits the goal):",
  ];
  for (const g of groups) {
    lines.push("", `- **${g.label}** — ${g.purpose}`);
    for (const t of g.tools) {
      lines.push(`    - \`${t.name}\`${t.summary ? ` — ${t.summary}` : ""}`);
    }
  }
  return lines.join("\n");
}
