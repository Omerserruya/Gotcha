/**
 * Turning a tool execution into a line an operator can read.
 *
 * The activity card needs a SENTENCE - "Refunded 179 ILS to Dana Cohen for
 * order 1842" - and the platform renders it in Hebrew as often as English. So
 * the server never composes one. It emits a `kind` code and the `values` that
 * go in the blanks, and the client owns the wording, the order of the clauses
 * and the direction of the text. A pre-rendered English sentence cannot be
 * translated, and a translation table keyed on English is a table that breaks
 * the first time someone rewords it.
 *
 * `kind` is `<noun>.<outcome>` because both halves matter to the reader:
 * "refund.completed" and "refund.failed" are different events on the same
 * card, and the noun is what decides the icon.
 */

export type ActivityOutcome = "completed" | "failed" | "awaiting_approval";

export interface ActivitySubject {
  /** What the action was performed ON. */
  type: "order" | "customer" | "contact" | "lead" | "deal" | "conversation" | "none";
  /** The identifier a human recognises - an order NUMBER, not an internal id. */
  id: string | null;
}

export interface ActivityEvent {
  id: string;
  at: string;
  outcome: ActivityOutcome;
  kind: string;
  values: Record<string, unknown>;
  subject: ActivitySubject;
  conversationId: string | null;
}

/**
 * Tool slug to the noun its event is about, and the kind of thing it acts on.
 *
 * Drawn from the seeded catalog_tools slugs rather than invented. Anything not
 * listed falls back to the slug itself as the noun, which reads plainly
 * ("add_contact_note.completed") and is honest about not having been mapped -
 * far better than silently filing an unknown action under a familiar heading.
 */
const TOOL_EVENTS: Record<string, { noun: string; subject: ActivitySubject["type"] }> = {
  // Money leaving the business. The ones an owner scans the card for.
  process_refund: { noun: "refund", subject: "order" },
  refund_payment: { noun: "refund", subject: "order" },
  refund_capture: { noun: "refund", subject: "order" },
  check_refund: { noun: "refund_check", subject: "order" },
  get_refund_status: { noun: "refund_check", subject: "order" },

  cancel_order: { noun: "order_cancel", subject: "order" },
  edit_order: { noun: "order_edit", subject: "order" },
  add_order_note: { noun: "order_note", subject: "order" },
  exchange_order_item: { noun: "order_exchange", subject: "order" },
  create_return: { noun: "return", subject: "order" },
  check_return_status: { noun: "return_check", subject: "order" },
  get_return_status: { noun: "return_check", subject: "order" },

  get_order: { noun: "order_lookup", subject: "order" },
  order_lookup: { noun: "order_lookup", subject: "order" },
  find_latest_order: { noun: "order_lookup", subject: "order" },
  find_delayed_order: { noun: "order_lookup", subject: "order" },
  get_tracking_number: { noun: "tracking", subject: "order" },
  get_tracking_url: { noun: "tracking", subject: "order" },
  get_shipment_status: { noun: "tracking", subject: "order" },
  check_delivery_eta: { noun: "tracking", subject: "order" },

  create_discount_code: { noun: "discount", subject: "customer" },
  create_coupon: { noun: "discount", subject: "customer" },
  create_one_time_coupon: { noun: "discount", subject: "customer" },
  create_payment_link: { noun: "payment_link", subject: "customer" },
  create_invoice: { noun: "invoice", subject: "customer" },

  create_lead: { noun: "lead", subject: "lead" },
  convert_lead: { noun: "lead_convert", subject: "lead" },
  create_contact: { noun: "contact", subject: "contact" },
  create_customer: { noun: "customer", subject: "customer" },
  create_deal: { noun: "deal", subject: "deal" },
  add_tag: { noun: "tag", subject: "customer" },
  add_contact_tag: { noun: "tag", subject: "contact" },
  add_vip_tag: { noun: "tag", subject: "customer" },
};

/** Keys worth showing, in the order a reader wants them. */
const VALUE_KEYS = [
  "amount", "currency", "customer", "customerName", "quantity",
  "reason", "code", "discount", "carrier", "trackingNumber", "eta", "status",
];

/** Where an order NUMBER might hide, most human-recognisable first. */
const ORDER_ID_KEYS = ["orderNumber", "order_number", "orderName", "name", "orderId", "order_id", "id"];
const SUBJECT_ID_KEYS: Record<ActivitySubject["type"], string[]> = {
  order: ORDER_ID_KEYS,
  customer: ["customerId", "customer_id", "email", "phone", "id"],
  contact: ["contactId", "contact_id", "email", "phone", "id"],
  lead: ["leadId", "lead_id", "email", "id"],
  deal: ["dealId", "deal_id", "id"],
  conversation: ["conversationId", "conversation_id"],
  none: [],
};

function pick(source: unknown, keys: string[]): string | null {
  if (!source || typeof source !== "object") return null;
  const obj = source as Record<string, unknown>;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

/**
 * Scalars only, and only from a known list.
 *
 * A tool's input and output are arbitrary provider JSON. Passing them through
 * would put whatever the provider returned - addresses, card metadata, a whole
 * customer record - onto a dashboard card that has no business showing it, and
 * into whatever logs the frontend keeps. An allow-list is the only version of
 * this that cannot leak by accident when a provider adds a field.
 */
function collectValues(input: unknown, output: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const source of [output, input]) {
    if (!source || typeof source !== "object") continue;
    const obj = source as Record<string, unknown>;
    for (const key of VALUE_KEYS) {
      if (key in out) continue;
      const v = obj[key];
      if (typeof v === "string" && v.trim()) out[key] = v.trim();
      else if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
      else if (typeof v === "boolean") out[key] = v;
    }
  }
  // One name for one idea: `customerName` and `customer` are the same blank in
  // the sentence, and two spellings would make the client handle both.
  if (out.customerName && !out.customer) {
    out.customer = out.customerName;
    delete out.customerName;
  }
  return out;
}

export interface ToolExecutionLike {
  id: string;
  toolName: string;
  input: unknown;
  output: unknown;
  success: boolean;
  createdAt: Date;
  conversationId: string | null;
}

/** Project a tool execution onto the activity contract. */
export function toActivityEvent(row: ToolExecutionLike): ActivityEvent {
  const mapping = TOOL_EVENTS[row.toolName];
  const noun = mapping?.noun ?? (row.toolName || "action");
  const subjectType = mapping?.subject ?? "none";
  const outcome: ActivityOutcome = row.success ? "completed" : "failed";

  return {
    id: row.id,
    at: row.createdAt.toISOString(),
    outcome,
    kind: `${noun}.${outcome}`,
    values: collectValues(row.input, row.output),
    subject: {
      type: subjectType,
      id: subjectType === "none"
        ? null
        : pick(row.output, SUBJECT_ID_KEYS[subjectType]) ?? pick(row.input, SUBJECT_ID_KEYS[subjectType]),
    },
    conversationId: row.conversationId,
  };
}

export interface ApprovalRequestLike {
  id: string;
  tool: string;
  params: unknown;
  createdAt: Date;
  conversationId: string | null;
}

/**
 * A pending approval is an activity too.
 *
 * It is the one entry an operator can still change the outcome of, so leaving
 * it out would make the card a record of things already done - and the action
 * waiting on them the only thing it did not mention.
 */
export function approvalToActivityEvent(row: ApprovalRequestLike): ActivityEvent {
  // Dotted tool names (`shopify.process_refund`) share the mapping with their
  // bare form; the integration prefix is a routing detail, not a different act.
  const bare = row.tool.includes(".") ? row.tool.slice(row.tool.lastIndexOf(".") + 1) : row.tool;
  const mapping = TOOL_EVENTS[bare];
  const noun = mapping?.noun ?? (bare || "action");
  const subjectType = mapping?.subject ?? "none";

  return {
    id: row.id,
    at: row.createdAt.toISOString(),
    outcome: "awaiting_approval",
    kind: `${noun}.awaiting_approval`,
    values: collectValues(row.params, null),
    subject: {
      type: subjectType,
      id: subjectType === "none" ? null : pick(row.params, SUBJECT_ID_KEYS[subjectType]),
    },
    conversationId: row.conversationId,
  };
}

/**
 * What a tool acts ON, for callers that need the noun without the event.
 *
 * Exported so the "right now" line groups by the SAME table the activity
 * stream files events under. Two tables would drift, and then the card would
 * say "checking 4 orders" while the stream below it called the same executions
 * something else.
 */
export function toolSubject(toolName: string): ActivitySubject["type"] {
  const bare = toolName.includes(".") ? toolName.slice(toolName.lastIndexOf(".") + 1) : toolName;
  return TOOL_EVENTS[bare]?.subject ?? "none";
}

export const __ACTIVITY_INTERNALS__ = { TOOL_EVENTS, VALUE_KEYS };
