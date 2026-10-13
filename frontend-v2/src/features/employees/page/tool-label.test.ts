import { describe, expect, it } from 'vitest';

import { toolLabel } from './tool-label';

/** E5: an action's name - never its raw tool name on a page in words. */
const names = (slug: string) => (slug === 'woocommerce' ? 'WooCommerce' : null);
const own = (toolName: string) => `own:${toolName}`;

describe('★★ an action’s name', () => {
  it('an integration’s: the server’s name, with its integration', () => {
    expect(
      toolLabel(
        { toolName: 'woocommerce.get_customer', label: 'שליפת לקוח', integration: 'woocommerce' },
        names,
        own,
      ),
    ).toBe('WooCommerce · שליפת לקוח');
  });

  it('★ the server sending the tool’s own name is no name: ours instead', () => {
    expect(
      toolLabel({ toolName: 'send_message', label: 'send_message', integration: null }, names, own),
    ).toBe('own:send_message');
  });

  it('an integration we cannot name: the action alone', () => {
    expect(toolLabel({ toolName: 'shop.get', label: 'Get', integration: 'shop' }, names, own)).toBe(
      'Get',
    );
  });

  it('nothing at all: the name made readable, never the raw one', () => {
    const label = toolLabel(
      { toolName: 'crm.update_lead_stage', label: null, integration: null },
      names,
      own,
    );
    expect(label).not.toBe('crm.update_lead_stage');
    expect(label).not.toContain('_');
  });
});

describe('★ an integration’s action the server could not name', () => {
  it('its label is its tool name: no name, so the name made readable - never "WooCommerce · woocommerce.x"', () => {
    const label = toolLabel(
      {
        toolName: 'woocommerce.list_refunds',
        label: 'woocommerce.list_refunds',
        integration: 'woocommerce',
      },
      names,
      own,
    );
    expect(label).not.toContain('woocommerce.list_refunds');
  });
});
