import { humaniseCode } from '@/api/contracts/capabilities';

import type { ToolLevelRow } from './EmployeeToolLevels';

/**
 * ★★ E3 (Omer, 2026-10-14): an employee's tools as the business thinks of
 * them - by integration (GOTCHA's own first, then WooCommerce, Shopify,
 * Gmail...), and inside each by its business section (Orders, Coupons,
 * Customers...), from the server (Backend 0d922065).
 *
 * Sections keep the order the business reads them in; one the server adds
 * later goes after the known ones, before "other". Rows keep the server's
 * order inside a section.
 */
export const DOMAIN_ORDER = [
  'messaging',
  'handover',
  'customers',
  'leads',
  'calendar',
  'automation',
  'orders',
  'products',
  'coupons',
  'payments',
  'shipping',
  'returns',
  'notes',
  'records',
] as const;

export type ToolDomainGroup = {
  /** `other` when the server named none. */
  readonly domain: string;
  readonly icon: string | null;
  /** The server's label in the reader's language; `null`: the screen's own word for "other". */
  readonly label: string | null;
  readonly rows: readonly ToolLevelRow[];
};

export type ToolIntegrationGroup = {
  /** `null`: GOTCHA's own built-in actions. */
  readonly integration: string | null;
  /** `null` for GOTCHA's own; else the integration's name, or its slug made readable. */
  readonly name: string | null;
  readonly domains: readonly ToolDomainGroup[];
};

const rank = (domain: string) => {
  if (domain === 'other') return DOMAIN_ORDER.length + 1;
  const at = (DOMAIN_ORDER as readonly string[]).indexOf(domain);
  return at === -1 ? DOMAIN_ORDER.length : at;
};

export function toolSections(rows: readonly ToolLevelRow[]): ToolIntegrationGroup[] {
  const integrations = new Map<string | null, ToolLevelRow[]>();
  for (const row of rows) {
    const key = row.integration ?? null;
    integrations.set(key, [...(integrations.get(key) ?? []), row]);
  }
  return [...integrations.entries()]
    .sort(([a], [b]) => (a === null ? -1 : b === null ? 1 : 0))
    .map(([integration, own]) => {
      const domains = new Map<string, ToolLevelRow[]>();
      for (const row of own) {
        const domain = row.domain?.trim() || 'other';
        domains.set(domain, [...(domains.get(domain) ?? []), row]);
      }
      return {
        integration,
        name:
          integration === null
            ? null
            : own.find((row) => row.integrationName?.trim())?.integrationName?.trim() ||
              humaniseCode(integration),
        domains: [...domains.entries()]
          .sort(([a], [b]) => rank(a) - rank(b))
          .map(([domain, inDomain]) => ({
            domain,
            icon: inDomain[0]?.domainIcon ?? null,
            label: inDomain.find((row) => row.domainLabel?.trim())?.domainLabel?.trim() ?? null,
            rows: inDomain,
          })),
      };
    });
}
