import { getLocale, getTranslations } from 'next-intl/server';

import {
  approvableAsIs,
  bulkWouldTake,
  hasEvidence,
  inGroup,
  type Candidate,
  type ReviewGroup,
} from '@/api/contracts/knowledge-candidates';

import styles from './Channels.module.css';

/** The order a reviewer works in: what needs them, then the outcomes. */
const GROUPS: readonly ReviewGroup[] = ['needs_a_look', 'ready', 'already_covered', 'rejected'];

/**
 * The report to approve — screen 13f.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE CLAIM IS TRUE BY CONSTRUCTION, SO IT IS WORTH MAKING
 * ════════════════════════════════════════════════════════════════════════════
 * Approving CREATES a knowledge document, and nothing in the AI path reads a
 * candidate. So an answer sitting in "needs a look" cannot reach a customer —
 * not by policy, by shape. Said at the top, because a reviewer who does not
 * believe it will rush, and rushing is the failure this screen exists to
 * prevent.
 *
 * ── AND THE SECOND SENTENCE IS THE SCHEMA'S ──
 * *"Historical answers are EVIDENCE, NOT TRUTH. Human agents make mistakes,
 * grant one-off exceptions, quote superseded…"* A reviewer who thinks they
 * are confirming facts will approve everything; one who knows they are
 * reading what a colleague once said will read it.
 *
 * ── WHAT THE DESIGN ASKS FOR AND CANNOT HAVE ──
 * A comparison against "the website's version". Nothing records a document's
 * origin, so a duplicate can only be *"already in your knowledge base"* —
 * calling it the website would assert a provenance the schema does not carry.
 *
 * A shortcut to add a missing reply language. There is nowhere to add one.
 * Named rather than drawn.
 */
export async function KnowledgeReview({
  candidates,
  bulkMinConfidence,
}: {
  readonly candidates: readonly Candidate[];
  /** `BULK_APPROVE_MIN_CONFIDENCE`, so the count matches what the server takes. */
  readonly bulkMinConfidence: number;
}) {
  const t = await getTranslations('channels.whatsapp');
  const locale = await getLocale();
  const day = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
  const bulkCount = bulkWouldTake(candidates, bulkMinConfidence);

  return (
    <section className={styles.review} data-testid="review">
      <h2 className={styles.sectionHeading}>{t('review.heading')}</h2>

      <p className={styles.reviewLead} data-testid="review-nothing-used">
        {t('review.nothingUsedYet')}
      </p>
      <p className={styles.deliveryDetail} data-testid="review-evidence-not-truth">
        {t('review.evidenceNotTruth')}
      </p>

      {bulkCount > 0 ? (
        <div className={styles.fixHere} data-testid="review-bulk">
          <p className={styles.checkDetail}>{t('review.bulkApprove', { count: bulkCount })}</p>
          {/*
            A promise, not a footnote. The eligible set is computed server-side
            and the client cannot pass a list, so this button cannot approve a
            conflict however it is pressed — and a merchant who does not know
            that will approve fifty things one at a time.
          */}
          <p className={styles.checkDetail} data-testid="review-bulk-safe">
            {t('review.bulkSafe')}
          </p>
        </div>
      ) : null}

      {GROUPS.map((group) => {
        const rows = inGroup(candidates, group);
        return (
          <section key={group} data-testid={`review-group-${group}`}>
            <h3 className={styles.checkHeading}>{t(`review.group.${group}`)}</h3>

            {/*
              "Already covered" is not a rejection, and the heading alone does
              not say so. Without this a reviewer reads a list of their own
              knowledge under a heading next to "Rejected" and concludes it
              was turned down.
            */}
            {group === 'already_covered' && rows.length > 0 ? (
              <p className={styles.checkDetail} data-testid="review-already-covered-body">
                {t('review.alreadyCoveredBody')}
              </p>
            ) : null}

            {rows.length === 0 ? (
              <p className={styles.checkDetail}>{t('review.empty')}</p>
            ) : (
              <ul className={styles.reviewRows}>
                {rows.map((c) => (
                  <li key={c.id} className={styles.reviewRow} data-testid="review-candidate">
                    <p className={styles.reviewQuestion}>{c.question}</p>
                    <p className={styles.reviewAnswer}>{c.answer}</p>

                    {/*
                      ★ BEFORE APPROVAL, NOT AFTER. A candidate can be
                      maximally confident and still unsafe to state: "we
                      usually do viewings Thursday and Friday" is true, and an
                      agent asserting it promises a slot nobody checked.
                    */}
                    {c.requiresLiveLookup ? (
                      <p className={styles.reviewLive} data-testid="review-live-lookup">
                        {t('review.liveLookup')}
                      </p>
                    ) : null}

                    {c.conflict ? (
                      <p className={styles.reviewConflict} data-testid="review-conflict">
                        {t('review.conflict')}
                      </p>
                    ) : null}

                    {c.duplicateOfDocumentId ? (
                      <p className={styles.checkDetail} data-testid="review-duplicate">
                        {t('review.duplicateOf')}
                      </p>
                    ) : null}

                    {/*
                      What the curation pass did, in its own words. Same rule
                      as `customerMessage` and `metaSolution`: the platform
                      authored a sentence for this reader, so it renders.
                    */}
                    {c.curationVerdict ? (
                      <p className={styles.checkDetail} data-testid="review-curation">
                        {t(`review.curation.${c.curationVerdict}`)}
                        {c.curationNote ? ` ${c.curationNote}` : ''}
                      </p>
                    ) : null}

                    {/*
                      The reviewer's actual decision input, which the design
                      gives them none of: one agent once, or forty customers
                      over six months.
                    */}
                    {hasEvidence(c) ? (
                      <p className={styles.checkDetail} data-testid="review-evidence">
                        {c.firstSeenAt && c.lastSeenAt
                          ? t('review.evidence', {
                              occurrences: c.occurrenceCount,
                              customers: c.customerCount,
                              from: day.format(new Date(c.firstSeenAt)),
                              to: day.format(new Date(c.lastSeenAt)),
                            })
                          : t('review.evidenceNoDates', {
                              occurrences: c.occurrenceCount,
                              customers: c.customerCount,
                            })}
                      </p>
                    ) : null}

                    {approvableAsIs(c) ? (
                      <span className={styles.reviewActions} data-testid="review-actions" />
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}

      <p className={styles.checkDetail} data-testid="review-rerun-safe">
        {t('review.rerunSafe')}
      </p>

      {/* Named, not drawn — there is nowhere to add a reply language. */}
      <p className={styles.checkDetail} data-testid="review-no-language-shortcut">
        {t('review.noLanguageShortcut')}
      </p>
    </section>
  );
}
