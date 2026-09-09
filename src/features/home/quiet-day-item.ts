import type { QuietDayItem } from '@/api/contracts/analytics';

/**
 * Which message a ranked item uses, and where its action goes.
 *
 * Pure and separate from the card so both can be tested without a translation
 * runtime — this is where an unrecognised source would otherwise reach the
 * screen as a missing-key crash.
 */

/** Sources with their own wording. Anything else falls back rather than throws. */
const KNOWN_SOURCES = new Set([
  'knowledge_gap',
  'knowledge_conflict',
  'product_demand',
  'dormant_customers',
]);

/**
 * Where each row leads.
 *
 * Dormant customers go to the campaign builder, not to a draft: the drafted
 * message was dropped as a product decision, and the flow is create → template
 * approval → send.
 */
const DESTINATIONS: Record<string, string> = {
  knowledge_gap: '/studio/knowledge',
  knowledge_conflict: '/studio/knowledge',
  product_demand: '/analytics/topics',
  dormant_customers: '/outreach',
};

export interface QuietDayCopy {
  readonly key: string;
  readonly values: Record<string, string | number>;
  readonly href: string;
}

export function quietDayCopy(item: QuietDayItem): QuietDayCopy {
  // `kind` is `<source>.<detail>`; the wording is keyed on the source, because
  // the detail distinguishes why a gap exists, not how to describe it.
  const source = item.kind.includes('.') ? item.kind.slice(0, item.kind.indexOf('.')) : item.kind;
  const key = KNOWN_SOURCES.has(source) ? source : 'fallback';

  return {
    key,
    values: scalarsOf(item.values),
    href: DESTINATIONS[source] ?? '/',
  };
}

/**
 * The values ICU can interpolate.
 *
 * `values` is `Record<string, unknown>` by contract. Anything that is not a
 * scalar is dropped rather than stringified into `[object Object]`.
 */
function scalarsOf(values: Record<string, unknown>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'string' || typeof value === 'number') out[key] = value;
  }
  return out;
}
