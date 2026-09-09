import { getTranslations } from 'next-intl/server';

import type { Insight } from '@/api/contracts/analytics';

import styles from './Home.module.css';

/**
 * "Worth knowing" — one thing GOTCHA noticed, on Home's right column.
 *
 * The insight arrives as `kind` + `values`; the sentence is written here. It
 * used to arrive as composed English prose with the numbers already inside it,
 * which could not be rendered on a Hebrew screen at all.
 *
 * One card, not a list: the design surfaces a single trend. Showing five would
 * make it a second inbox, which is the thing Home is built to avoid.
 */

/** The observations with their own wording. Anything else falls back. */
const KNOWN_KINDS = new Set([
  'intent.automatable',
  'intent.multiple_automatable',
  'escalation.rate_high',
  'confidence.below_threshold',
  'channel.highest_volume',
  'department.load_imbalance',
]);

export async function WorthKnowing({ insights }: { insights: readonly Insight[] | null }) {
  const t = await getTranslations('home.insight');

  // Highest impact first, and only then the order the backend returned.
  const rank = { high: 0, medium: 1, low: 2 } as const;
  const top = insights ? [...insights].sort((a, b) => rank[a.impact] - rank[b.impact])[0] : null;

  return (
    <section className={styles.insightCard}>
      <p className={styles.insightTitle}>{t('title')}</p>

      {insights === null ? (
        <p className={styles.emptyNote}>{t('unavailable')}</p>
      ) : !top ? (
        // Not a failure. Nothing standing out is a good morning, and saying so
        // is better than an empty box that reads as something not loading.
        <p className={styles.emptyNote}>{t('empty')}</p>
      ) : (
        <p className={styles.insightBody}>
          {t.rich(kindKey(top.kind), {
            ...scalarsOf(top.values),
            b: (chunks) => <b>{chunks}</b>,
          })}
        </p>
      )}
    </section>
  );
}

function kindKey(kind: string): string {
  return KNOWN_KINDS.has(kind) ? `kind.${kind}` : 'kind.fallback';
}

/**
 * The values ICU can interpolate.
 *
 * `values` is `Record<string, unknown>` by contract — the backend allow-lists
 * what goes in, but the type cannot say so. Anything that is not a scalar is
 * dropped rather than stringified into `[object Object]`.
 */
function scalarsOf(values: Record<string, unknown>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'string' || typeof value === 'number') out[key] = value;
  }
  return out;
}
