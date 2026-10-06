/**
 * One label map for the inbox's live line and the customer timeline.
 *
 * ★ The reported defect: `get_customer_orders` matched the customer rule and
 * read as "identifying the customer". Order rules now sit above it. Every
 * other case below is a name from the real tool catalogue whose first match
 * was wrong before the rules were ordered and tightened.
 */
import { describe, it, expect } from "vitest";
import { activityLabelKey, ACTIVITY_LABEL_KEYS, bareToolName } from "../lib/ai-activity-labels";

const cases: Array<[string, string]> = [
  ["shopify.get_customer_orders", "looking_up_order"],
  ["integration_order_lookup", "looking_up_order"],
  ["search_orders", "looking_up_order"],
  ["get_customer", "identifying_customer"],
  ["get_customer_tags", "identifying_customer"],   // a read, not tagging
  ["get_contact_notes", "identifying_customer"],   // a read, not adding a note
  ["add_vip_tag", "tagging_customer"],
  ["add_order_note", "adding_note"],
  ["list_discounts", "checking_discount"],         // a read, not creating one
  ["create_one_time_coupon", "creating_discount"],
  ["refund_payment", "processing_refund"],         // money moves
  ["get_refund_status", "checking_refund"],
  ["create_payment_link", "sending_payment_link"],
  ["shopify.get_returns", "handling_return"],
  ["get_fulfillment_status", "checking_delivery"],
  ["woocommerce.update_order_status", "updating_order"],
  ["update_customer", "saving_customer"],
  ["escalate_to_human", "handing_to_team"],
  ["query_records", "working"],
];

describe("activityLabelKey", () => {
  it.each(cases)("%s → %s", (tool, key) => {
    expect(activityLabelKey(tool)).toBe(key);
  });

  it("strips provider prefixes and integration_", () => {
    expect(bareToolName("shopify.order_lookup")).toBe("order_lookup");
    expect(bareToolName("integration_cancel_order")).toBe("cancel_order");
  });

  it("every key a rule can return is listed, plus the fallback", () => {
    for (const [, key] of cases) expect(ACTIVITY_LABEL_KEYS).toContain(key);
    expect(ACTIVITY_LABEL_KEYS).toContain("working");
  });
});
