import { getFormatter, getTranslations } from 'next-intl/server';

import {
  hasAmbiguousName,
  lastRefreshed,
  notReadyCount,
  staleSources,
  undatedSources,
  STALE_AFTER_DAYS,
  type KnowledgeSource,
  type UnansweredQuestion,
} from '@/api/contracts/knowledge';
import { lastHeardFor, variantsOf, type Candidate } from '@/api/contracts/knowledge-candidates';

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
  conflicts,
  conflictsScannedAt,
  everImported,
}: {
  readonly sources: readonly KnowledgeSource[] | null;
  readonly unanswered: readonly UnansweredQuestion[] | null;
  readonly conflicts: readonly Candidate[] | null;
  readonly conflictsScannedAt: string | null;
  readonly everImported: boolean;
}) {
  const t = await getTranslations('knowledge');
  const format = await getFormatter();

  const date = (iso: string | null) =>
    iso ? format.dateTime(new Date(iso), { day: 'numeric', month: 'long', year: 'numeric' }) : null;

  /*
   * ══════════════════════════════════════════════════════════════════════
   * ★★ THE HEADER IS THREE COUNTERS, NOT THE DESIGN'S FOUR
   * ══════════════════════════════════════════════════════════════════════
   * *"Answers confidently · 34 topics"* and *"Thin — guesses sometimes · 6"*
   * are not rendered, and not because a threshold is missing.
   *
   * `confidence` is a column on `KnowledgeCandidate` and on no other
   * knowledge model. A candidate is a suggestion awaiting approval, and
   * approving one creates a `KnowledgeDocument`, which has no confidence
   * column — so the score exists only while the thing is **not yet
   * knowledge** and is discarded the moment it becomes knowledge.
   *
   * Counting pending candidates under a header that says *"what GOTCHA
   * knows about your business"* would be counting the inbox as the filing
   * cabinet. The screen says the measure does not exist instead.
   *
   * ── AND THE ONE WE DO COMPUTE SHOWS ITS WORKING ──
   * "Out of date" is ours: ninety days, chosen between the design's own
   * "rescanned yesterday · Fresh" and "last change 5 months ago · Ageing".
   * So the counter names the threshold, and each source prints its date
   * beside the verdict — a reader who thinks three months is fine for a
   * returns policy can see the fact and disagree with us.
   */
  const stale = sources ? staleSources(sources, new Date()) : [];
  const undated = sources ? undatedSources(sources) : [];

  return (
    <div className={styles.screen} data-testid="knowledge-screen">
      {sources !== null ? (
        <section className={styles.counters} data-testid="knowledge-counters">
          <p className={styles.counter} data-testid="counter-sources">
            {t('counters.sources', { count: sources.length })}
          </p>

          {/*
            ★ THE FACT IS THE COUNTER, THE THRESHOLD IS THE CAPTION.
            "4 out of date" is a verdict; "4 not refreshed in 90 days" is
            what we actually know, and it is the same length.
          */}
          <p className={styles.counter} data-testid="counter-stale">
            {t('counters.stale', { count: stale.length, days: STALE_AFTER_DAYS })}
          </p>

          {/*
            Separate, because "we cannot tell when this was last read" is a
            different thing to tell somebody than "this is old". Shown only
            when it is true — a zero here is noise.
          */}
          {undated.length > 0 ? (
            <p className={styles.counter} data-testid="counter-undated">
              {t('counters.undated', { count: undated.length })}
            </p>
          ) : null}

          <p className={styles.counter} data-testid="counter-conflicts">
            {conflicts === null
              ? t('counters.conflictsUnknown')
              : t('counters.conflicts', { count: conflicts.length })}
          </p>

          {/*
            ★★ THE COUNTER THAT IS NOT THERE, SAID RATHER THAN OMITTED.
            A reader coming from the design will look for "answers
            confidently" and find nothing. An absence explains itself once;
            a missing counter gets re-requested every time somebody reads
            the design next to the screen.
          */}
          <p className={styles.counterAbsent} data-testid="counter-no-confidence">
            {t('counters.noConfidence')}
          </p>
        </section>
      ) : null}

      {/*
        ════════════════════════════════════════════════════════════════════
        ★★ THE CONFLICT — AND IT IS NOT THE CONFLICT THE DESIGN DRAWS
        ════════════════════════════════════════════════════════════════════
        The design shows two NAMED SOURCES disagreeing: "₪550 · your website ·
        wholesale page · updated March" against "₪850 · Wholesale terms PDF ·
        uploaded July".

        What this platform detects is different and the schema says so in as
        many words: *"The business answered this differently at different
        times. We do NOT pick one."* It clusters semantically-equivalent
        questions out of past conversations and keeps every answer that was
        given, with how often each was said.

        Cross-source contradiction — website versus PDF, with each side's
        name and date — **does not exist**, and captioning these as though it
        did would be inventing provenance. So the panel says what it is: the
        business answered this question in more than one way, here is each
        answer and how often it was heard.

        ── AND THE SCAN IS NOT CONTINUOUS ──
        `knowledge-clustering.stage.ts` runs inside the historical-import
        pipeline only. An empty list means "nothing contradicted itself in
        what we imported", never "GOTCHA's knowledge is consistent". That
        sentence is on the screen, not in this comment.
      */}
      <section className={styles.section} data-testid="conflicts-section">
        <h2 className={styles.sectionHeading}>{t('conflicts.heading')}</h2>

        {conflicts === null ? (
          <p className={styles.degraded} data-testid="conflicts-unavailable">
            {t('conflicts.unavailable')}
          </p>
        ) : !everImported ? (
          /*
           * ★ NOTHING HAS EVER LOOKED, WHICH IS NOT "NOTHING DISAGREES".
           * Without an import the clustering stage has never run at all, so
           * an empty list here carries no information whatsoever — and
           * "no contradictions" would be the most misleading thing on the
           * screen.
           */
          <p className={styles.none} data-testid="conflicts-never-scanned">
            {t('conflicts.neverScanned')}
          </p>
        ) : conflicts.length === 0 ? (
          <p className={styles.none} data-testid="conflicts-none">
            {conflictsScannedAt
              ? t('conflicts.noneScanned', { when: date(conflictsScannedAt) ?? '' })
              : t('conflicts.none')}
          </p>
        ) : (
          <ul className={styles.conflicts}>
            {conflicts.map((candidate) => {
              const variants = variantsOf(candidate);
              return (
                <li
                  key={candidate.id}
                  className={styles.conflict}
                  data-testid={`conflict-${candidate.id}`}
                >
                  <p className={styles.conflictQuestion}>{candidate.question}</p>
                  <p className={styles.conflictAsked}>
                    {t('conflicts.asked', { count: candidate.occurrenceCount })}
                  </p>

                  {/*
                    ★ BOTH ANSWERS, NEITHER PREFERRED. The route sorts them
                    by how often each was heard and the platform explicitly
                    refuses to pick — so the screen shows the order it was
                    given and marks nothing as the winner. An "most likely"
                    badge here would be the product making the decision it
                    says is the owner's.
                  */}
                  <ul className={styles.variants}>
                    {variants.map((variant) => {
                      const heard = lastHeardFor(variant, candidate.examples);
                      return (
                        <li
                          key={variant.key}
                          className={styles.variant}
                          data-testid={`variant-${candidate.id}-${variant.key}`}
                        >
                          <p className={styles.variantAnswer}>{variant.answer}</p>
                          <p className={styles.variantMeta}>
                            {t('conflicts.said', { count: variant.occurrenceCount })}
                            {/*
                              Dropped by the dedupe merge, so shown only
                              where it survived. Absent is absent — a zero
                              here would read as "no customers", which is
                              a claim nobody made.
                            */}
                            {variant.customerCount !== null && variant.customerCount !== undefined
                              ? ` · ${t('conflicts.byCustomers', { count: variant.customerCount })}`
                              : ''}
                            {/*
                              Reconstructed from the representative examples
                              via `variantKey`. At most three are returned,
                              so a later variant may have none — and then it
                              gets no date rather than borrowing another's.
                            */}
                            {heard
                              ? ` · ${t('conflicts.lastHeard', { when: date(heard) ?? '' })}`
                              : ''}
                          </p>
                        </li>
                      );
                    })}
                  </ul>

                  {/*
                    ⚠ NO RESOLVE CONTROL HERE, AND NOT BECAUSE ONE IS MISSING.
                    `POST /candidates/:id/approve` with `editedAnswer` is the
                    resolve path and it exists. It writes to the tenant's
                    knowledge base, which every AI employee answers from —
                    so it is a write this screen introduces, not one it
                    inherits, and it goes in once the panel itself is
                    accepted. The sentence below says what happens until then.
                  */}
                  <p className={styles.conflictMeanwhile}>{t('conflicts.meanwhile')}</p>
                </li>
              );
            })}
          </ul>
        )}

        {/*
          ★★ THE COVERAGE STATEMENT, ALWAYS, NOT ONLY WHEN THE LIST IS EMPTY.
          A reader looking at two conflicts needs to know the scan was of one
          import and has not run since, exactly as much as a reader looking
          at none does.
        */}
        <p className={styles.coverage} data-testid="conflicts-coverage">
          {t('conflicts.coverage')}
        </p>
      </section>

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
