import { getFormatter, getTranslations } from 'next-intl/server';

import type { ProductDemand } from '@/api/contracts/analytics';

import styles from './Analytics.module.css';

/**
 * Screen 06d — what conversations were worth. Measured.
 *
 * The dark card and "What you lost" (824 + 300), a five-figure strip, then
 * "Where the money came from" (724) and "What people ask for and don't get"
 * (400).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ NOTHING TIES A SALE TO A CONVERSATION
 * ════════════════════════════════════════════════════════════════════════════
 * No revenue is attributed to a conversation, a source or a campaign, and no
 * purchase intent or cart recovery is recorded. So the money parts of 06d are
 * drawn and say so; the figures are "—", never a confident zero.
 *
 * What IS recorded is the other half of 02's argument — lost opportunity:
 * `/product-demand`, the catalogue searches this ISO week that found nothing.
 * Shown as ASKS (`askCount`), never as people: the writer's `askedBy` is not
 * de-duplicated by asker. No value is put on them — nothing prices a miss.
 */

/** "navy towels" → "Navy towels": terms are stored lowercased. */
export function termWords(term: string): string {
  return term ? term.charAt(0).toLocaleUpperCase() + term.slice(1) : term;
}

export async function SalesHero() {
  const t = await getTranslations('analytics');
  return (
    <section className={styles.gHero} data-testid="sales-hero">
      <p className={styles.gHeroEyebrow}>{t('sales.hero.eyebrow')}</p>
      <p className={styles.gHeroTitle}>{t('sales.hero.title')}</p>
      <p className={styles.gHeroLine}>{t('sales.hero.line')}</p>
      <div className={styles.gActions}>
        <span className={styles.gLight} aria-disabled="true">
          {t('sales.hero.which')}
        </span>
        <span className={styles.gDarkOutline} aria-disabled="true">
          {t('sales.hero.compare')}
        </span>
      </div>
    </section>
  );
}

/** 02's "What you lost": the week's asks for what you don't stock. */
export async function WhatYouLost({ demand }: { readonly demand: ProductDemand | null }) {
  const t = await getTranslations('analytics');
  const format = await getFormatter();
  const misses = demand?.data.filter((row) => !row.inCatalogue) ?? [];
  const asks = misses.reduce((sum, row) => sum + row.askCount, 0);
  return (
    <section className={styles.sLost} data-testid="sales-lost">
      <p className={styles.sLostTitle}>{t('sales.lost.title')}</p>
      <p className={styles.sLostBody}>
        {demand === null
          ? '—'
          : misses.length === 0
            ? t('sales.lost.none')
            : t('sales.lost.body', {
                asks: format.number(asks),
                terms: misses.length,
              })}
      </p>
      {/* Writing to them would create outreach — waits on Omer. */}
      <span className={styles.sLostLink} aria-disabled="true">
        {t('sales.lost.write')}
      </span>
    </section>
  );
}

export async function SalesStrip() {
  const t = await getTranslations('analytics');
  const keys = ['revenue', 'wanted', 'bought', 'average', 'carts'] as const;
  return (
    <dl className={styles.gStrip} data-testid="sales-strip">
      {keys.map((key) => (
        <div key={key} className={styles.gCell} data-testid={`sales-${key}`}>
          <dt>{t(`sales.strip.${key}`)}</dt>
          {/* Nothing records it: not attributed, not counted. */}
          <dd>—</dd>
        </div>
      ))}
    </dl>
  );
}

/** 02's "Where the money came from": kept in its place, said why it is empty. */
export async function MoneySources() {
  const t = await getTranslations('analytics');
  return (
    <section className={styles.sSources} data-testid="sales-sources">
      <h2 className={styles.gCardTitle}>{t('sales.sources.title')}</h2>
      <p className={styles.gNone}>{t('sales.sources.none')}</p>
      <p className={styles.gDidFoot}>{t('sales.sources.foot')}</p>
    </section>
  );
}

/** 02's "What people ask for and don't get": this ISO week's catalogue misses. */
export async function AskedNotGot({ demand }: { readonly demand: ProductDemand | null }) {
  const t = await getTranslations('analytics');
  const format = await getFormatter();
  const misses = demand?.data.filter((row) => !row.inCatalogue) ?? [];
  return (
    <section className={styles.sAsked} data-testid="sales-asked">
      <header className={styles.sAskedHead}>
        <h2 className={styles.gCardTitle}>{t('sales.asked.title')}</h2>
        <span className={styles.gCardMeta}>{t('sales.asked.week')}</span>
      </header>
      <div className={styles.sAskedBody}>
        {demand === null ? (
          <p className={styles.sAskedNone} data-testid="sales-asked-unavailable">
            {t('sales.asked.unavailable')}
          </p>
        ) : misses.length === 0 ? (
          <p className={styles.sAskedNone} data-testid="sales-asked-none">
            {t('sales.asked.none')}
          </p>
        ) : (
          <ul className={styles.sAskedList}>
            {misses.map((row) => (
              <li key={row.id} className={styles.sAskedRow} data-testid={`asked-${row.id}`}>
                <span className={styles.sAskedText}>
                  <span className={styles.sAskedTerm}>{termWords(row.term)}</span>
                  <span className={styles.sAskedSub}>
                    {row.weeksRunning > 1
                      ? t('sales.asked.running', { weeks: row.weeksRunning })
                      : t('sales.asked.notStocked')}
                  </span>
                </span>
                <span className={styles.sAskedCount}>
                  {t('sales.asked.asks', { count: row.askCount, n: format.number(row.askCount) })}
                </span>
                {/* Nothing prices a miss. */}
                <span className={styles.sAskedValue}>—</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {misses[0] ? (
        <p className={styles.sAskedFoot} data-testid="sales-asked-foot">
          {t('sales.asked.foot', {
            term: termWords(misses[0].term),
            count: misses[0].askCount,
            n: format.number(misses[0].askCount),
          })}
        </p>
      ) : null}
    </section>
  );
}
