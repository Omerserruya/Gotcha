import { getFormatter, getTranslations } from 'next-intl/server';

import {
  hasAmbiguousName,
  lastRefreshed,
  notReadyCount,
  type KnowledgeSource,
  type UnansweredQuestion,
} from '@/api/contracts/knowledge';

import styles from './Knowledge.module.css';

/**
 * Screen 08 — what GOTCHA knows, and what it does not.
 *
 * ── THE DATE, NOT THE VERDICT ──
 * The design labels each source *"Fresh"* and counts *"Out of date · 4"*.
 * `updatedAt` is real; **a staleness policy is not** — no threshold, no
 * field, no job anywhere in the platform. So each source says **when** it was
 * last refreshed and leaves the judgement to the reader, who knows their own
 * business well enough to decide whether two months is fine.
 *
 * ── AND THE QUESTIONS ARE THE SCREEN ──
 * The design's headline counts — confident topics, thin topics, out of date —
 * have no source. What is real is **the list of questions GOTCHA could not
 * answer**, with `timesAsked` and `distinctAskers` kept apart: one person
 * asking twenty times is a stuck customer, twenty people asking once is a
 * missing page, and a single "asked 23 times" cannot tell you which.
 */
export async function KnowledgeScreen({
  sources,
  unanswered,
}: {
  readonly sources: readonly KnowledgeSource[] | null;
  readonly unanswered: readonly UnansweredQuestion[] | null;
}) {
  const t = await getTranslations('knowledge');
  const format = await getFormatter();

  const date = (iso: string | null) =>
    iso ? format.dateTime(new Date(iso), { day: 'numeric', month: 'long', year: 'numeric' }) : null;

  return (
    <div className={styles.screen} data-testid="knowledge-screen">
      {/* ── What it could not answer ─────────────────────────────────── */}
      <section className={styles.section} data-testid="gaps-section">
        <h2 className={styles.sectionHeading}>{t('gaps.heading')}</h2>

        {unanswered === null ? (
          <p className={styles.degraded} data-testid="gaps-unavailable">
            {t('gaps.unavailable')}
          </p>
        ) : unanswered.length === 0 ? (
          <p className={styles.none} data-testid="gaps-none">
            {t('gaps.none')}
          </p>
        ) : (
          <ul className={styles.gaps}>
            {unanswered.map((question) => (
              <li key={question.id} className={styles.gap} data-testid={`gap-${question.id}`}>
                <p className={styles.gapQuestion}>{question.question}</p>
                {/*
                  Kept apart on purpose. One person asking twenty times and
                  twenty people asking once are different problems, and the
                  design's single "asked 23 times" cannot distinguish them.
                */}
                <p className={styles.gapCount}>
                  {t('gaps.asked', {
                    times: question.timesAsked,
                    people: question.distinctAskers,
                  })}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── Where it learns from ─────────────────────────────────────── */}
      <section className={styles.section} data-testid="sources-section">
        <h2 className={styles.sectionHeading}>{t('sources.heading')}</h2>

        {sources === null ? (
          <p className={styles.degraded} data-testid="sources-unavailable">
            {t('sources.unavailable')}
          </p>
        ) : sources.length === 0 ? (
          <div className={styles.empty} data-testid="sources-none">
            <p className={styles.emptyLead}>{t('sources.none')}</p>
            <p className={styles.emptyBody}>{t('sources.noneBody')}</p>
          </div>
        ) : (
          <ul className={styles.sources}>
            {sources.map((source) => {
              const refreshed = date(lastRefreshed(source));
              const pending = notReadyCount(source);
              return (
                <li key={source.id} className={styles.source} data-testid={`source-${source.id}`}>
                  <p className={styles.sourceName}>
                    {source.name || t('sources.unnamed')}
                    {/*
                      Two sources on this tenant share a name. Printing it
                      twice tells the reader nothing about which is which, so
                      an ambiguous name is shown with what distinguishes them.
                    */}
                    {hasAmbiguousName(source, sources) ? (
                      <span className={styles.disambiguate} data-testid={`same-name-${source.id}`}>
                        {t('sources.sameName')}
                      </span>
                    ) : null}
                  </p>

                  <p className={styles.sourceMeta} data-testid={`docs-${source.id}`}>
                    {t('sources.documents', { count: source.documents.length })}
                    {/*
                      WHEN, not whether that is good. There is no staleness
                      policy in the platform, so no source is labelled fresh
                      or stale — the date is stated and the reader judges.
                    */}
                    {refreshed ? ` · ${t('sources.refreshed', { date: refreshed })}` : null}
                  </p>

                  {pending > 0 ? (
                    <p className={styles.pending} data-testid={`pending-${source.id}`}>
                      {t('sources.pending', { count: pending })}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
