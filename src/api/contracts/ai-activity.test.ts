import { describe, expect, it } from 'vitest';

import { labelForTool } from './ai-activity';

/*
 * The copy of Backend's shared ACTIVITY_LABEL_RULES (a9c79156), used only where
 * the server sends no labelKey (04e's audit events and approvals). These are
 * the cases their tests pin, including the order that makes get_customer_orders
 * an order lookup. When this drifts from
 * theirs, a tool reads differently in 04e than in the inbox panel.
 */
describe('labelForTool - Backend’s rules, mirrored', () => {
  it.each([
    ['shopify.process_refund', 'processing_refund'],
    ['integration_cancel_order', 'cancelling_order'],
    ['shopify.get_returns', 'handling_return'],
    ['shopify.get_fulfillment_status', 'checking_delivery'],
    ['woocommerce.update_order_status', 'updating_order'],
    ['integration_order_lookup', 'looking_up_order'],
    // a9c79156: orders before customers, and a refund read is not a refund.
    ['shopify.get_customer_orders', 'looking_up_order'],
    ['shopify.get_refund', 'checking_refund'],
    ['shopify.create_payment_link', 'sending_payment_link'],
    ['crm.create_task', 'creating_task'],
    ['shopify.list_discounts', 'checking_discount'],
    ['shopify.search_products', 'checking_products'],
    ['escalate_to_human', 'handing_to_team'],
  ])('%s → %s', (tool, label) => {
    expect(labelForTool(tool)).toBe(label);
  });

  it('★ no rule: null - the caller says the tool’s own name, not "working"', () => {
    expect(labelForTool('something_new')).toBeNull();
    expect(labelForTool('shopify.reindex_widgets')).toBeNull();
  });
});
