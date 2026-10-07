import { describe, expect, it } from 'vitest';

import { emptyPlan, withAccess, type HireTool } from './hire-plan';

const tool = (provider: string | null): HireTool => ({
  toolName: `${provider ?? 'gotcha'}.x`,
  label: 'X',
  provider,
  providerLabel: provider,
  choices: ['ask_me'],
  current: 'ask_me',
});

describe('★ the plan’s systems start where the server starts a new employee', () => {
  it('every system set up today, with or without actions here; GOTCHA’s own is not a system', () => {
    const plan = emptyPlan([tool(null), tool('shopify')], ['woocommerce', 'custom:t1']);
    expect(plan.access).toEqual(['custom:t1', 'shopify', 'woocommerce']);
  });

  it('one system off and on again, the rest untouched', () => {
    const plan = emptyPlan([tool('shopify')], ['hubspot']);
    const off = withAccess(plan, 'shopify', false);
    expect(off.access).toEqual(['hubspot']);
    expect(withAccess(off, 'shopify', true).access).toEqual(['hubspot', 'shopify']);
    expect(withAccess(plan, 'shopify', true).access).toEqual(['hubspot', 'shopify']);
  });
});
