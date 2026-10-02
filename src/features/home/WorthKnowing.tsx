import { getTranslations } from 'next-intl/server';

import { readableValues } from '@/api/contracts/capabilities';
import type { Insight } from '@/api/contracts/analytics';
import { channelName } from '@/api/contracts/inbox';

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
  const channelNames = await getTranslations('channels');

  // Highest impact first, and only then the order the backend returned.
  const top = insights ? rankInsights(insights)[0] : null;

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
            ...readableValues(top.values, (key, value) =>
              key === 'channel' ? channelName(value, channelNames) : null,
            ),
            b: (chunks) => <b>{chunks}</b>,
          })}
        </p>
      )}
    </section>
  );
}

export function kindKey(kind: string): string {
  return KNOWN_KINDS.has(kind) ? `kind.${kind}` : 'kind.fallback';
}

/*
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THE SPREAD WAS THE DEFECT, NOT THE SENTENCE
 * ════════════════════════════════════════════════════════════════════════════
 * This card used to spread the backend's bag into the sentence through a local
 * `scalarsOf`, which dropped non-scalars and passed every string through
 * verbatim. A browser at `/v2` read:
 *
 *     71 conversations came through WHATSAPP in the last 30 days.
 *
 * `readableValues` replaces it and lives in `contracts/capabilities` on
 * purpose: **the hole is the spread, and the spread is a pattern, not a site.**
 * Repairing `{channel}` here would have fixed today's screenshot and left the
 * next `kind` — and the next placeholder added to an existing message — with
 * the same free pass.
 *
 * The resolver is only for `channel`, because `channels.json` is translated and
 * `humaniseCode('SHOPIFY_LIVE_CHAT')` is English on a Hebrew screen. Every
 * other key falls back to `humaniseCode`, which is the part that cannot go
 * stale.
 *
 * ── ONE CORRECTION TO THE REPORT THAT FOUND THIS ──
 * `department.load_imbalance` was expected to carry a department identifier the
 * same way. Its message says "one department" and interpolates no name, so it
 * does not — today. That is a fact about one string in one catalogue, which is
 * exactly the kind of thing that changes without anyone thinking about this
 * file, and it is why the fix is at the spread anyway.
 */

/** Highest impact first, and only then the order the backend returned. */
export function rankInsights(insights: readonly Insight[]): readonly Insight[] {
  const rank = { high: 0, medium: 1, low: 2 } as const;
  return [...insights].sort((a, b) => rank[a.impact] - rank[b.impact]);
}
