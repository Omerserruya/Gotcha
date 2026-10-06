import { describe, expect, it } from 'vitest';

import { labelForTool } from './ai-activity';

/*
 * A mirror of Backend's LABEL_RULES (services/ai/src/services/ai-activity.service.ts).
 * These are the cases their own test pins (ed0f1c9c), plus the order that
 * decides "escalate_to_human" before anything else. When this drifts from
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
    ['shopify.search_products', 'checking_products'],
    ['escalate_to_human', 'handing_to_team'],
  ])('%s → %s', (tool, label) => {
    expect(labelForTool(tool)).toBe(label);
  });

  it('★ no rule: null - the caller says the tool’s own name, not "working"', () => {
    expect(labelForTool('something_new')).toBeNull();
    expect(labelForTool('shopify.lookup_order')).toBeNull();
  });
});
