import { describe, expect, it } from 'vitest';

import type { ToolLevelRow } from './EmployeeToolLevels';
import { toolSections } from './tool-sections';

const row = (toolName: string, over: Partial<ToolLevelRow> = {}): ToolLevelRow => ({
  toolName,
  label: toolName,
  workspaceLevel: 'ask',
  ownLevel: null,
  employeeLevel: 'ask',
  allowedLevels: ['ask', 'never'],
  granted: null,
  grantable: false,
  ...over,
});
const woo = (toolName: string, domain: string | null, label: string | null = domain) =>
  row(`woocommerce.${toolName}`, {
    integration: 'woocommerce',
    integrationName: 'WooCommerce',
    domain,
    domainIcon: domain,
    domainLabel: label,
  });
const own = (toolName: string, domain: string) =>
  row(toolName, { integration: null, domain, domainIcon: domain, domainLabel: domain });

describe('★★ E3 - tools by integration, then by business section', () => {
  it('★ GOTCHA’s own first, then each integration in the server’s order', () => {
    const groups = toolSections([
      woo('get_order', 'orders'),
      row('shopify.get_order', {
        integration: 'shopify',
        integrationName: 'Shopify',
        domain: 'orders',
      }),
      own('send_message', 'messaging'),
    ]);
    expect(groups.map((g) => [g.integration, g.name])).toEqual([
      [null, null],
      ['woocommerce', 'WooCommerce'],
      ['shopify', 'Shopify'],
    ]);
  });

  it('★★ sections in the business’s order, a new one after the known, "other" last; rows keep the server’s order', () => {
    const [group] = toolSections([
      woo('a', 'other'),
      woo('b', 'subscriptions'),
      woo('c', 'shipping'),
      woo('d', 'orders'),
      woo('e', 'coupons'),
      woo('f', 'orders'),
    ]);
    expect(group!.domains.map((d) => d.domain)).toEqual([
      'orders',
      'coupons',
      'shipping',
      'subscriptions',
      'other',
    ]);
    expect(group!.domains[0]!.rows.map((r) => r.toolName)).toEqual([
      'woocommerce.d',
      'woocommerce.f',
    ]);
  });

  it('each section carries the server’s icon key and label', () => {
    const [group] = toolSections([woo('get_coupon', 'coupons', 'קופונים והנחות')]);
    expect(group!.domains[0]).toMatchObject({
      domain: 'coupons',
      icon: 'coupons',
      label: 'קופונים והנחות',
    });
  });

  it('an older server, no section: one "other" section, its label left to the screen', () => {
    const [group] = toolSections([woo('get_order', null, null), woo('get_coupon', '  ', null)]);
    expect(group!.domains).toHaveLength(1);
    expect(group!.domains[0]).toMatchObject({ domain: 'other', label: null });
    expect(group!.domains[0]!.rows).toHaveLength(2);
  });

  it('an integration the server did not name: its slug made readable, never blank', () => {
    const [group] = toolSections([
      row('acme_crm.get', { integration: 'acme_crm', integrationName: null, domain: 'records' }),
    ]);
    expect(group!.name).toBeTruthy();
    expect(group!.name).not.toBe('acme_crm');
  });
});
