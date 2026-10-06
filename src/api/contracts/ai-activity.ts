import { z } from 'zod';

import { ACTIVITY_STATUSES } from '@/lib/ai-activity-status';

/**
 * The AI's steps in one conversation - Backend ed0f1c9c.
 *
 * `GET /api/ai-assist/:conversationId/ai-activity?limit=` reads the
 * orchestrator's own rows (one per tool call) and projects them without the
 * arguments or the result: `{ data: [{ id, tool, labelKey, status,
 * proposedAt, startedAt, completedAt, durationMs, error }] }`, newest first.
 * Live: `ai.activity.updated` on `conv:{id}`, one per step change.
 */

export { ACTIVITY_STATUSES, type ActivityStatus } from '@/lib/ai-activity-status';

/**
 * Every `labelKey` `labelKeyFor` can return (ai-activity.service.ts). A key
 * not in this list is drawn as `working` - the service's own fallback.
 */
export const ACTIVITY_LABELS = [
  'looking_up_order',
  'checking_products',
  'processing_refund',
  'cancelling_order',
  'handling_return',
  'checking_delivery',
  'updating_order',
  'creating_discount',
  'sending_order_email',
  'adding_note',
  'checking_calendar',
  'booking_meeting',
  'identifying_customer',
  'saving_customer',
  'tagging_customer',
  'scheduling_followup',
  'handing_to_team',
  'working',
] as const;
export type ActivityLabel = (typeof ACTIVITY_LABELS)[number];

export const labelOf = (key: string): ActivityLabel =>
  (ACTIVITY_LABELS as readonly string[]).includes(key) ? (key as ActivityLabel) : 'working';

export const activityStepSchema = z.object({
  id: z.string().min(1),
  tool: z.string().catch(''),
  labelKey: z.string().catch('working'),
  /*
   * ★ ONE UNKNOWN STATUS IS ONE STEP DRAWN QUIETLY, NOT A REJECTED LIST.
   *   `null` here is "a status this screen does not know".
   */
  status: z.enum(ACTIVITY_STATUSES).nullable().catch(null),
  proposedAt: z.string().nullable().catch(null).default(null),
  startedAt: z.string().nullable().catch(null).default(null),
  completedAt: z.string().nullable().catch(null).default(null),
  durationMs: z.number().nonnegative().nullable().catch(null).default(null),
  error: z.string().nullable().catch(null).default(null),
});
export type ActivityStep = z.infer<typeof activityStepSchema>;

/* Strict on the envelope: a service older than ed0f1c9c answers 404/HTML, which is "unread". */
export const activityResponseSchema = z.object({ data: z.array(activityStepSchema) });

/**
 * Backend's `LABEL_RULES` (ai-activity.service.ts), mirrored for the places
 * that carry a bare `tool` and no `labelKey` (04e's approvals, the timeline's
 * `ai_action`). Ordered: the first match on the bare name wins. `null` when
 * nothing matches - the caller shows the tool's own name rather than the
 * service's "working".
 */
const LABEL_RULES: readonly (readonly [RegExp, ActivityLabel])[] = [
  [/^escalate_to_human$/, 'handing_to_team'],
  [/refund/, 'processing_refund'],
  [/cancel_order/, 'cancelling_order'],
  [/(create|get)_returns?$|exchange_order_item/, 'handling_return'],
  [
    /track_shipment|shipment_status|tracking_url|delivery_eta|fulfillment_status/,
    'checking_delivery',
  ],
  [
    /update_order_shipping_address|edit_order|update_order_fulfillment|update_order_status/,
    'updating_order',
  ],
  [
    /order_lookup|find_latest_order|get_order|reconcile_order_items|list_orders/,
    'looking_up_order',
  ],
  [/search_products|variant_information|list_products|get_product/, 'checking_products'],
  [/coupon|discount/, 'creating_discount'],
  [/send_invoice|resend_confirmation/, 'sending_order_email'],
  [/add_order_note|create_note/, 'adding_note'],
  [/check_availability/, 'checking_calendar'],
  [/schedule_meeting/, 'booking_meeting'],
  [
    /link_customer_identifier|resolve_identity|get_customer|search_customers|get_contact|update_my_profile/,
    'identifying_customer',
  ],
  [/create_lead|create_contact|update_contact|update_crm/, 'saving_customer'],
  [/tag_contact/, 'tagging_customer'],
  [/schedule_followup/, 'scheduling_followup'],
];

/** "shopify.order_lookup" / "integration_order_lookup" → its label, or `null`. */
export function labelForTool(tool: string): ActivityLabel | null {
  const afterDot = tool.includes('.') ? tool.slice(tool.lastIndexOf('.') + 1) : tool;
  const name = afterDot.replace(/^integration_/, '').toLowerCase();
  return LABEL_RULES.find(([pattern]) => pattern.test(name))?.[1] ?? null;
}
