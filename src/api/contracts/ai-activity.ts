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
  // a9c79156
  'checking_refund',
  'checking_payment',
  'sending_payment_link',
  'checking_discount',
  'creating_task',
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
 * ⚠ ONLY FOR ROWS THE SERVER SENDS NO `labelKey` FOR: 04e's audit events and
 *   approvals. The inbox panel and the customer timeline carry `labelKey`
 *   from Backend's one shared map (a9c79156) and never come here.
 *
 * A copy of that map, `@chatcenter/shared` `ACTIVITY_LABEL_RULES`, in its
 * order (specific before general: `get_customer_orders` is an order lookup).
 * Delete this the day the audit log and approvals send `labelKey` too.
 */
const LABEL_RULES: readonly (readonly [RegExp, ActivityLabel])[] = [
  [/^escalate_to_human$/, 'handing_to_team'],
  [/^(process|issue)_refund$|^refund_(capture|payment)$/, 'processing_refund'],
  [/refund/, 'checking_refund'],
  [/^cancel_order$/, 'cancelling_order'],
  [
    /(^|_)(create|get)_returns?$|return_status|return_reason|exchange_order_item/,
    'handling_return',
  ],
  [
    /track_shipment|shipment_status|tracking_(url|number)|delivery_eta|fulfillment_(status|events)|delayed_order|pickup_point/,
    'checking_delivery',
  ],
  [/^update_order_|^edit_order$/, 'updating_order'],
  [/payment_link/, 'sending_payment_link'],
  [/payment_status|financial_status|^(get|list)_transactions$/, 'checking_payment'],
  [/send_invoice|create_invoice|resend_confirmation/, 'sending_order_email'],
  [
    /order_lookup|find_latest_order|(^|_)get_orders?$|customer_orders|order_items|(list|search)_orders/,
    'looking_up_order',
  ],
  [
    /search_products|variant_information|list_products|get_product|inventory_status/,
    'checking_products',
  ],
  [/^(create|issue)_\w*(coupon|discount)/, 'creating_discount'],
  [/^(validate|list)_discounts?$|customer_discounts/, 'checking_discount'],
  [/^(add|create)_(\w+_)?note$/, 'adding_note'],
  [/(^|_)(create|log)_task$/, 'creating_task'],
  [/check_availability/, 'checking_calendar'],
  [/schedule_meeting/, 'booking_meeting'],
  [/schedule_followup/, 'scheduling_followup'],
  [/^(add|remove)_(\w+_)?tag$|^tag_contact$/, 'tagging_customer'],
  [/^(create|update)_(lead|contact|customer|deal)$|update_crm|convert_lead/, 'saving_customer'],
  [
    /link_customer_identifier|resolve_identity|get_customer|summarize_customer|update_my_profile|^(search|get)_(contacts?|customers?|leads?|deals?)$|^(contact|lead|deal)_search$|^get_(contact|lead)_notes$/,
    'identifying_customer',
  ],
];

/** "shopify.order_lookup" / "integration_order_lookup" → its label, or `null`. */
export function labelForTool(tool: string): ActivityLabel | null {
  const afterDot = tool.includes('.') ? tool.slice(tool.lastIndexOf('.') + 1) : tool;
  const name = afterDot.replace(/^integration_/, '');
  return LABEL_RULES.find(([pattern]) => pattern.test(name))?.[1] ?? null;
}
