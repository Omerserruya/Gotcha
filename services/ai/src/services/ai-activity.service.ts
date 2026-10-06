/**
 * What the AI is doing in a conversation, step by step - for the inbox panel's
 * live line ("Looking up the order…", "Checking stock…").
 *
 * The source is tool_execution_requests: every chat tool call already goes
 * through the ActionOrchestrator, which writes a row per call and moves its
 * status (proposed → running → completed | failed, or denied/approved). This
 * module only READS it, and projects each step without its arguments or its
 * result - the same rule the orchestrator's events follow.
 *
 * `labelKey` is a stable key for the screen to translate, not prose: the
 * panel is bilingual and the tool name ("shopify.reconcile_order_items") is
 * not something to show a merchant.
 */
import { prisma } from "@chatcenter/shared";

export type ActivityStatus = "proposed" | "approved" | "running" | "completed" | "failed" | "denied";

/** Ordered: the first pattern that matches the bare tool name wins. */
const LABEL_RULES: Array<[RegExp, string]> = [
  [/^escalate_to_human$/, "handing_to_team"],
  [/refund/, "processing_refund"],
  [/cancel_order/, "cancelling_order"],
  [/(create|get)_returns?$|exchange_order_item/, "handling_return"],
  [/track_shipment|shipment_status|tracking_url|delivery_eta|fulfillment_status/, "checking_delivery"],
  [/update_order_shipping_address|edit_order|update_order_fulfillment|update_order_status/, "updating_order"],
  [/order_lookup|find_latest_order|get_order|reconcile_order_items|list_orders/, "looking_up_order"],
  [/search_products|variant_information|list_products|get_product/, "checking_products"],
  [/coupon|discount/, "creating_discount"],
  [/send_invoice|resend_confirmation/, "sending_order_email"],
  [/add_order_note|create_note/, "adding_note"],
  [/check_availability/, "checking_calendar"],
  [/schedule_meeting/, "booking_meeting"],
  [/link_customer_identifier|resolve_identity|get_customer|search_customers|get_contact|update_my_profile/, "identifying_customer"],
  [/create_lead|create_contact|update_contact|update_crm/, "saving_customer"],
  [/tag_contact/, "tagging_customer"],
  [/schedule_followup/, "scheduling_followup"],
];

export const ACTIVITY_LABEL_KEYS = [...new Set([...LABEL_RULES.map(([, k]) => k), "working"])];

/** "shopify.order_lookup" / "integration_order_lookup" → "order_lookup". */
function bareName(tool: string): string {
  const afterDot = tool.includes(".") ? tool.slice(tool.lastIndexOf(".") + 1) : tool;
  return afterDot.replace(/^integration_/, "");
}

export function labelKeyFor(tool: string): string {
  const name = bareName(String(tool || ""));
  for (const [re, key] of LABEL_RULES) if (re.test(name)) return key;
  return "working";
}

/** The orchestrator's lifecycle event name → the step's status. */
export function statusForEvent(event: string): ActivityStatus | null {
  const m = /^tool\.execution\.(proposed|approved|started|completed|failed|denied)$/.exec(event);
  if (!m) return null;
  return m[1] === "started" ? "running" : (m[1] as ActivityStatus);
}

export interface ActivityStep {
  id: string;
  tool: string;
  labelKey: string;
  status: string;
  proposedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  /** Only for failed/denied steps; the provider's message, never the args. */
  error: string | null;
}

const MAX_LIMIT = 50;

/** The last `limit` steps for one conversation, newest first. */
export async function getAiActivity(tenantId: string, conversationId: string, limit = 20): Promise<ActivityStep[]> {
  const take = Math.min(Math.max(1, Math.floor(limit) || 20), MAX_LIMIT);
  const rows = await (prisma as any).toolExecutionRequest.findMany({
    where: { tenantId, conversationId },
    orderBy: { proposedAt: "desc" },
    take,
    // args/result are deliberately NOT selected: they hold customer data and
    // the panel needs neither.
    select: { id: true, tool: true, status: true, error: true, proposedAt: true, startedAt: true, completedAt: true },
  });
  return rows.map((r: any) => ({
    id: r.id,
    tool: r.tool,
    labelKey: labelKeyFor(r.tool),
    status: r.status,
    proposedAt: r.proposedAt?.toISOString?.() ?? String(r.proposedAt),
    startedAt: r.startedAt ? r.startedAt.toISOString() : null,
    completedAt: r.completedAt ? r.completedAt.toISOString() : null,
    durationMs: r.startedAt && r.completedAt ? r.completedAt.getTime() - r.startedAt.getTime() : null,
    error: r.status === "failed" || r.status === "denied" ? (r.error ?? null) : null,
  }));
}
