/**
 * What the AI is doing, as a stable key a screen translates ("looking_up_order"
 * → "Looking up the order…"). ONE map for every surface: the inbox panel's live
 * line (services/ai ai-activity) and the customer timeline's ai_action events
 * (services/conversation identity), so the two cannot label the same tool
 * differently - and Frontend no longer keeps a copy.
 *
 * Import-free on purpose, like conversation-visibility-rule.ts: services
 * deep-import it (`@chatcenter/shared/src/lib/ai-activity-labels`) without
 * pulling the barrel their tests mock.
 *
 * ★ ORDER MATTERS: the first rule that matches wins, so SPECIFIC rules come
 * before general ones. `get_customer_orders` is an order lookup, not
 * identifying a customer - the order rules sit above the customer rule for
 * exactly that reason, and the test pins it.
 */

/** Ordered: the first pattern that matches the BARE tool name wins. */
export const ACTIVITY_LABEL_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^escalate_to_human$/, "handing_to_team"],
  // Money moving out, and reading about it.
  [/^(process|issue)_refund$|^refund_(capture|payment)$/, "processing_refund"],
  [/refund/, "checking_refund"],
  [/^cancel_order$/, "cancelling_order"],
  [/(^|_)(create|get)_returns?$|return_status|return_reason|exchange_order_item/, "handling_return"],
  [/track_shipment|shipment_status|tracking_(url|number)|delivery_eta|fulfillment_(status|events)|delayed_order|pickup_point/, "checking_delivery"],
  [/^update_order_|^edit_order$/, "updating_order"],
  [/payment_link/, "sending_payment_link"],
  [/payment_status|financial_status|^(get|list)_transactions$/, "checking_payment"],
  [/send_invoice|create_invoice|resend_confirmation/, "sending_order_email"],
  // ORDERS before CUSTOMERS: get_customer_orders must land here.
  [/order_lookup|find_latest_order|(^|_)get_orders?$|customer_orders|order_items|(list|search)_orders/, "looking_up_order"],
  [/search_products|variant_information|list_products|get_product|inventory_status/, "checking_products"],
  [/^(create|issue)_\w*(coupon|discount)/, "creating_discount"],
  [/^(validate|list)_discounts?$|customer_discounts/, "checking_discount"],
  [/^(add|create)_(\w+_)?note$/, "adding_note"],
  [/(^|_)(create|log)_task$/, "creating_task"],
  [/check_availability/, "checking_calendar"],
  [/schedule_meeting/, "booking_meeting"],
  [/schedule_followup/, "scheduling_followup"],
  [/^(add|remove)_(\w+_)?tag$|^tag_contact$/, "tagging_customer"],
  [/^(create|update)_(lead|contact|customer|deal)$|update_crm|convert_lead/, "saving_customer"],
  [/link_customer_identifier|resolve_identity|get_customer|summarize_customer|update_my_profile|^(search|get)_(contacts?|customers?|leads?|deals?)$|^(contact|lead|deal)_search$|^get_(contact|lead)_notes$/, "identifying_customer"],
];

export const ACTIVITY_LABEL_KEYS: readonly string[] = [...new Set([...ACTIVITY_LABEL_RULES.map(([, k]) => k), "working"])];

/** "shopify.order_lookup" / "integration_order_lookup" → "order_lookup". */
export function bareToolName(tool: string): string {
  const s = String(tool || "");
  const afterDot = s.includes(".") ? s.slice(s.lastIndexOf(".") + 1) : s;
  return afterDot.replace(/^integration_/, "");
}

/** The label key for a tool name; "working" when nothing more specific fits. */
export function activityLabelKey(tool: string): string {
  const name = bareToolName(tool);
  for (const [re, key] of ACTIVITY_LABEL_RULES) if (re.test(name)) return key;
  return "working";
}
