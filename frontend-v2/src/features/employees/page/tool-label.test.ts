import { describe, expect, it } from 'vitest';

import { toolLabel, toolLevelRows } from './tool-label';

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

describe('★★ E3 - the action’s own name, under its integration’s heading', () => {
  it('an integration’s action: the catalogue’s name alone; the full line keeps the integration', () => {
    const [r] = toolLevelRows(
      [
        {
          toolName: 'woocommerce.get_customer',
          label: 'שליפת לקוח',
          integration: 'woocommerce',
          integrationName: null,
          riskGroup: null,
          workspaceLevel: 'ask',
          ownLevel: null,
          employeeLevel: 'ask',
          allowedLevels: ['ask', 'never'],
          granted: true,
          grantable: true,
          domain: 'customers',
          domainIcon: 'customers',
          domainLabel: 'לקוחות',
        },
      ],
      names,
      own,
    )!;
    expect(r).toMatchObject({
      action: 'שליפת לקוח',
      label: 'WooCommerce · שליפת לקוח',
      // The systems list named it: the server sent none.
      integrationName: 'WooCommerce',
      domain: 'customers',
    });
  });

  it('★★ a built-in, whose label is its tool name: our own words - never the slug (dev, 2026-10-14)', () => {
    const [r] = toolLevelRows(
      [
        {
          toolName: 'close_conversation',
          label: 'close_conversation',
          integration: null,
          integrationName: null,
          riskGroup: null,
          workspaceLevel: 'execute',
          ownLevel: null,
          employeeLevel: 'execute',
          allowedLevels: ['execute', 'ask', 'never'],
          granted: null,
          grantable: false,
          domain: 'messaging',
          domainIcon: 'messaging',
          domainLabel: 'הודעות',
        },
      ],
      names,
      own,
    )!;
    expect(r!.action).toBe('own:close_conversation');
    expect(r!.label).toBe('own:close_conversation');
  });

  it('the server’s integration name wins over the systems list’s', () => {
    const [r] = toolLevelRows(
      [
        {
          toolName: 'woocommerce.get_order',
          label: 'Get an order',
          integration: 'woocommerce',
          integrationName: 'WooCommerce Store',
          riskGroup: null,
          workspaceLevel: 'ask',
          ownLevel: null,
          employeeLevel: 'ask',
          allowedLevels: ['ask'],
          granted: true,
          grantable: true,
          domain: 'orders',
          domainIcon: 'orders',
          domainLabel: 'Orders',
        },
      ],
      names,
      own,
    )!;
    expect(r!.integrationName).toBe('WooCommerce Store');
  });
});
