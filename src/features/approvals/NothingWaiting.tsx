import { getFormatter, getTranslations } from 'next-intl/server';

import { decisionStance, isOutcomeUnknown, type Approval } from '@/api/contracts/approvals';

import styles from './Approvals.module.css';

/**
 * Screen 03c — *"nothing waiting"*.
 *
 * Not a separate route: this **is** the Approvals screen when the queue is
 * empty, which is the point of the design note — *"the product working, not an
 * empty box"*. An empty approvals queue is the delegation succeeding, and it
 * must not read as a failure or as an absence.
 *
 * ── WHAT THE DESIGN LEADS WITH, AND WHY THIS DOES NOT ──
 * The design opens on *"31 actions, ₪2,840 of value, handled without asking
 * you today"* with a by-type breakdown. **The data for that exists and is
 * exactly right** — `PolicyDecision` is an append-only audit of every policy
 * evaluation, carrying `decision`, `actionKind`, `tool`, `maxAmount` and
 * `inputFacts`, indexed on `[tenantId, createdAt]`.
 *
 * **No route reads it.** Verified across every route file in the platform. So
 * the headline is unbuilt rather than fictional — a distinction worth keeping,
 * because it is one endpoint over correct data rather than machinery that does
 * not exist. It is requested, and until it lands this screen does not invent a
 * number, estimate one, or imply the figure is zero.
 *
 * ── AND WHAT IS REMOVED ──
 * Every row in the design carries **Undo**, and the header says *"all still
 * reversible for 24h"*. There is no undo in this platform. Both are gone
 * rather than disabled: a greyed-out Undo still tells you one existed.
 *
 * *"What GOTCHA learned from your rejections"* is also absent — nothing
 * anywhere derives a threshold change from a rejection. The reason itself is
 * real and is shown; the learning claimed about it is not.
 */
export async function NothingWaiting({
  decided,
  mayBeIncomplete,
  requesterNames,
}: {
  /** Approved and rejected, newest first. `null` is a failed read. */
  readonly decided: readonly Approval[] | null;
  /** The route's `take: 100` may have cut today's earliest decisions. */
  readonly mayBeIncomplete: boolean;
  readonly requesterNames: Readonly<Record<string, string>>;
}) {
  const t = await getTranslations('approvals');
  const format = await getFormatter();

  return (
    <div className={styles.nothingWaiting} data-testid="nothing-waiting">
      <header className={styles.restHeader}>
        <p className={styles.restLead} data-testid="nothing-waiting-lead">
          {t('rest.lead')}
        </p>
        <p className={styles.restBody}>{t('rest.body')}</p>
      </header>

      <section className={styles.decided} data-testid="decided-section">
        <h2 className={styles.decidedHeading}>{t('decided.heading')}</h2>

        {decided === null ? (
          <p className={styles.unknownOutcome} data-testid="decided-unavailable">
            {t('decided.unavailable')}
          </p>
        ) : decided.length === 0 ? (
          <p className={styles.restBody} data-testid="decided-empty">
            {t('decided.none')}
          </p>
        ) : (
          <>
            <ul className={styles.decidedList} data-testid="decided-list">
              {decided.map((approval) => {
                const stance = decisionStance(approval);
                return (
                  <li
                    key={approval.id}
                    className={styles.decidedRow}
                    data-testid={`decided-${approval.id}`}
                    data-stance={stance}
                  >
                    <p className={styles.decidedSummary}>{approval.summary}</p>

                    <p className={styles.decidedMeta}>
                      {/*
                        ══════════════════════════════════════════════════════
                        ★★ A TIME WITH NO DATE, ON A LIST SPANNING DAYS
                        ══════════════════════════════════════════════════════
                        A browser walk found 29 rows here reading "Approved by
                        someone at 12:43 AM", cycling through morning and
                        afternoon across what must be several days. `dateStyle`
                        was absent, so every row claimed a time and none said
                        which day.

                        ★ AND THE QUEUE'S REASONING DOES NOT APPLY HERE. I
                          argued against paging the pending queue because the
                          oldest item is the one that most needs deciding and
                          hiding it is the failure. **This is not a work queue,
                          it is a reference list** — the decisions are made, and
                          what a reader wants from it is when. Different list,
                          different answer.

                        ★★ AND AN ABSENT `decidedAt` RENDERED AS `''`, so the
                        row read "Approved by someone at " with a dangling
                        preposition. `decidedAt` is nullable on the contract, so
                        that is a real row and not a defensive branch. It now
                        takes a message with no time clause in it, rather than a
                        sentence with a hole.
                      */}
                      {approval.decidedAt
                        ? t(`decided.${stance}` as 'decided.approved', {
                            who: approval.decidedByName ?? t('decided.someone'),
                            when: format.dateTime(new Date(approval.decidedAt), {
                              dateStyle: 'medium',
                              timeStyle: 'short',
                            }),
                          })
                        : t(`decided.${stance}NoTime` as 'decided.approvedNoTime', {
                            who: approval.decidedByName ?? t('decided.someone'),
                          })}
                      {requesterNames[approval.id]
                        ? ` · ${t('decided.askedBy', { who: requesterNames[approval.id]! })}`
                        : null}
                    </p>

                    {/*
                      The rejection reason, shown because it is real. What the
                      design claims ABOUT it — that GOTCHA learned a threshold
                      from it — is not: nothing derives one.
                    */}
                    {stance === 'rejected' && approval.decisionReason ? (
                      <p className={styles.decidedReason} data-testid={`reason-${approval.id}`}>
                        {t('decided.because', { reason: approval.decisionReason })}
                      </p>
                    ) : null}

                    {/*
                      The second axis, on the screen that summarises the first.
                      An approval granted and then failed to execute is exactly
                      what someone reviewing their own decisions needs to see,
                      and it is the one thing the design's tidy list of green
                      ticks could never show.
                    */}
                    {stance === 'approved' && approval.executionState === 'FAILED' ? (
                      <p className={styles.decidedProblem} data-testid={`failed-${approval.id}`}>
                        {t('decided.didNotRun')}
                      </p>
                    ) : null}

                    {isOutcomeUnknown(approval) ? (
                      <p className={styles.decidedProblem} data-testid={`unknown-${approval.id}`}>
                        {t('decided.outcomeUnknown')}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>

            {/*
              `GET /api/approvals` takes one status, has no date filter, and
              caps at 100 per status. A count captioned "today" that silently
              means "of the last 100" is the kind of number somebody plans
              around, so the screen says which it is.
            */}
            {mayBeIncomplete ? (
              <p className={styles.decidedCaveat} data-testid="decided-incomplete">
                {t('decided.incomplete')}
              </p>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
