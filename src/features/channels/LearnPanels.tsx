import { getLocale, getTranslations } from 'next-intl/server';

import { humaniseCode } from '@/api/contracts/capabilities';
import { isRunning, workDone, type ImportStatus } from '@/api/contracts/historical-import';
import {
  bulkWouldTake,
  groupOf,
  inGroup,
  variantsOf,
  type Candidate,
  type ReviewGroup,
} from '@/api/contracts/knowledge-candidates';
import drawer from '@/design-system/styles/drawer.module.css';
import { Link } from '@/i18n/navigation';

import styles from './Channels.module.css';

const href = (view: 'progress' | 'report', importId: string, tab?: string) => ({
  pathname: '/settings/channels',
  query: { panel: 'whatsapp', import: importId, view, ...(tab ? { tab } : {}) },
});

/** A failure reason in words: the platform's sentence, or a code made readable. */
function reasonInWords(reason: string): string {
  return /^[a-z0-9_.-]+$/.test(reason) ? humaniseCode(reason) : reason;
}

/**
 * 13b's way into 13e / 13f: one row under the number card while there is an
 * import — "Learning in progress · 64%", "Report ready · 151 answers",
 * "Stopped", or "No history to learn from".
 */
export async function LearningRow({ status }: { readonly status: ImportStatus }) {
  const t = await getTranslations('channels.whatsapp');
  const view = status.stage === 'ready' ? 'report' : 'progress';
  return (
    <Link
      href={href(view, status.id)}
      className={styles.learningRow}
      data-stage={status.stage}
      data-testid="learning-row"
      scroll={false}
    >
      <span className={styles.learningRowText}>
        {status.stage === 'ready'
          ? t('learn.rowReady', { count: status.knowledgeCandidateCount })
          : status.stage === 'transferring'
            ? t('learn.rowImporting', { percent: status.percent })
            : status.stage === 'analyzing'
              ? t('learn.rowLearning', { percent: status.analysisPercent })
              : t(`import.stage.${status.stage}`)}
      </span>
      <span aria-hidden="true">›</span>
    </Link>
  );
}

type StepState = 'done' | 'active' | 'waiting' | 'failed';

/**
 * 13e, measured: "Setting up {number}" — the stepper (Where it lives ✓ ·
 * Meta ✓ · Number ✓ · ④ Learn), whether messages already arrive, a
 * timeline, "So far", and the way out.
 *
 * The timeline is the platform's two stages, not five steps. `transferring`
 * is "History imported"; `analyzing` is ONE stage in which learning how you
 * write, finding answers and remembering customers happen together — so
 * those three rows share its state and each carries its own measured count,
 * and none is drawn as waiting on the one before.
 */
export async function ImportPanel({
  status,
  receiving,
}: {
  readonly status: ImportStatus;
  /** Does the number already receive? Only then is "Connected" said. */
  readonly receiving: boolean;
}) {
  const t = await getTranslations('channels.whatsapp');
  const locale = await getLocale();
  const n = new Intl.NumberFormat(locale);
  const done = workDone(status);
  const failed = status.stage === 'failed';
  const failedAt = status.failedStage?.toLowerCase() ?? '';

  const importState: StepState =
    status.stage === 'transferring'
      ? 'active'
      : failed && failedAt.includes('transfer')
        ? 'failed'
        : status.stage === 'unavailable'
          ? 'waiting'
          : 'done';
  const learnState: StepState =
    status.stage === 'analyzing'
      ? 'active'
      : status.stage === 'ready'
        ? 'done'
        : failed && importState !== 'failed'
          ? 'failed'
          : 'waiting';

  const step = (
    key: string,
    state: StepState,
    title: string,
    sub: string | null,
    extra: React.ReactNode = null,
  ) => (
    <li
      key={key}
      className={styles.timelineStep}
      data-state={state}
      data-testid={`learn-step-${key}`}
    >
      <span className={styles.timelineDot} aria-hidden="true" />
      <span className={styles.timelineBody}>
        <span className={styles.timelineTitle}>{title}</span>
        {sub ? <span className={styles.timelineSub}>{sub}</span> : null}
        {extra}
      </span>
    </li>
  );

  const bar = (percent: number) => (
    <span className={styles.timelineBar} aria-hidden="true">
      <span style={{ inlineSize: `${Math.max(0, Math.min(100, percent))}%` }} />
    </span>
  );

  const topics = status.topTopics
    .map((topic) =>
      typeof topic === 'string'
        ? topic
        : typeof topic === 'object' && topic !== null
          ? ((topic as { topic?: unknown; label?: unknown }).topic ??
            (topic as { label?: unknown }).label)
          : null,
    )
    .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    .slice(0, 5);

  return (
    <>
      <div className={drawer.drawerBody} data-testid="import-panel" data-stage={status.stage}>
        <ol className={styles.stepper} aria-label={t('learn.steps')}>
          {(['where', 'meta', 'number'] as const).map((s) => (
            <li key={s} className={styles.stepperStep} data-state="done">
              <span className={styles.stepperMark} aria-hidden="true">
                ✓
              </span>
              {t(`learn.step.${s}`)}
            </li>
          ))}
          <li className={styles.stepperStep} data-state="current">
            <span className={styles.stepperMark} aria-hidden="true">
              4
            </span>
            {t('learn.step.learn')}
          </li>
        </ol>

        {receiving ? (
          <p className={styles.connectedLine} data-testid="import-live">
            {t('learn.connected')}
          </p>
        ) : null}

        {status.stage === 'unavailable' ? (
          <p className={styles.timelineSub} data-testid="import-unavailable">
            {t('import.unavailableBody')}
          </p>
        ) : (
          <ol className={styles.timeline} data-testid="learn-timeline">
            {step('connected', 'done', t('learn.connectedStep'), null)}
            {step(
              'imported',
              importState,
              t('learn.imported'),
              importState === 'active'
                ? null
                : done.conversationsTotal
                  ? t('learn.conversations', { count: n.format(done.conversationsTotal) })
                  : null,
              importState === 'active' ? bar(status.percent) : null,
            )}
            <li className={styles.timelineGroup} title={t('import.noOrder')}>
              <ol className={styles.timeline}>
                {step(
                  'learning',
                  learnState,
                  t('learn.learning'),
                  t('learn.learningSub'),
                  learnState === 'active' ? bar(status.analysisPercent) : null,
                )}
                {step(
                  'answers',
                  learnState,
                  t('learn.answers'),
                  done.answersFound > 0
                    ? t('import.answers', { count: done.answersFound })
                    : t('learn.answersSub'),
                )}
                {step(
                  'customers',
                  learnState,
                  t('learn.customers'),
                  done.customersTotal
                    ? t('import.customers', {
                        read: n.format(done.customersRead),
                        total: n.format(done.customersTotal),
                      })
                    : null,
                )}
              </ol>
            </li>
          </ol>
        )}

        {failed ? (
          <p className={styles.learnFailed} data-testid="import-failed">
            {status.failureReason
              ? reasonInWords(status.failureReason)
              : status.failedStage
                ? t('import.failedWithStage', { stage: status.failedStage })
                : t('import.failedBare')}
          </p>
        ) : null}

        {topics.length > 0 ? (
          <section className={styles.soFar} data-testid="learn-so-far">
            <h3 className={styles.soFarTitle}>{t('learn.soFar')}</h3>
            <p className={styles.soFarRow}>
              <span className={styles.soFarLabel}>{t('learn.mostAsked')}</span>
              <span>{topics.join(' · ')}</span>
            </p>
          </section>
        ) : null}
      </div>

      <footer className={drawer.drawerFoot}>
        <Link
          href={{ pathname: '/settings/channels', query: { panel: 'whatsapp' } }}
          className={styles.learnSecondary}
          title={
            isRunning(status)
              ? `${t('import.safeToClose')} ${t('import.emailOnDone')} ${t('import.emailNeedsAddress')}`
              : undefined
          }
          data-testid="import-close"
          scroll={false}
        >
          {t('learn.close')}
        </Link>
        {failed ? (
          <span
            className={styles.learnPrimary}
            aria-disabled="true"
            title={t('learn.rerunNotYet')}
            data-testid="import-rerun"
          >
            {t('learn.rerun')}
          </span>
        ) : status.stage === 'ready' ? (
          <Link
            href={href('report', status.id)}
            className={styles.learnPrimary}
            data-testid="import-review"
            scroll={false}
          >
            {t('learn.review')}
          </Link>
        ) : (
          <span
            className={styles.learnPrimary}
            aria-disabled="true"
            title={t('learn.reviewWhenReady')}
            data-testid="import-review"
          >
            {t('learn.review')}
          </span>
        )}
      </footer>
    </>
  );
}

const TABS = ['needs_a_look', 'ready', 'rejected', 'already_covered'] as const;

/**
 * 13f, measured: "What GOTCHA learned from {number}" · "Nothing is used
 * until you approve it." — the strip of four, three cards, the tabs, the
 * candidates as cards in two columns, the ready-in-bulk card, the footer.
 *
 * Approving, editing, rejecting, adding in bulk and running again are drawn
 * and not live: nothing in this app writes them yet, and each is a change to
 * what the AI tells customers. The reasons ride on their titles; no
 * explanatory paragraph.
 */
export async function ReportPanel({
  status,
  candidates,
  bulkMinConfidence,
  tab,
}: {
  readonly status: ImportStatus;
  readonly candidates: readonly Candidate[];
  readonly bulkMinConfidence: number | undefined;
  readonly tab: string | undefined;
}) {
  const t = await getTranslations('channels.whatsapp');
  const locale = await getLocale();
  const n = new Intl.NumberFormat(locale);
  const pct = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 });
  const current: ReviewGroup = (TABS as readonly string[]).includes(tab ?? '')
    ? (tab as ReviewGroup)
    : 'needs_a_look';
  const shown = inGroup(candidates, current);
  const bulk = bulkWouldTake(inGroup(candidates, 'needs_a_look'), bulkMinConfidence);
  const ready = inGroup(candidates, 'needs_a_look').filter(
    (c) => !c.conflict && bulkMinConfidence !== undefined && c.confidence >= bulkMinConfidence,
  );
  const notLive = t('learn.notLive');

  const chipOf = (c: Candidate): { text: string; tone: string } =>
    c.conflict
      ? { text: t('learn.chip.conflict'), tone: 'warn' }
      : c.requiresLiveLookup
        ? { text: t('learn.chip.live'), tone: 'quiet' }
        : bulkMinConfidence !== undefined && c.confidence < bulkMinConfidence
          ? { text: t('learn.chip.low'), tone: 'warn' }
          : { text: pct.format(c.confidence), tone: 'good' };

  return (
    <>
      <div className={drawer.drawerBody} data-testid="report-panel">
        <dl className={styles.reportStrip}>
          {[
            [
              'conversations',
              status.conversationsExtracted > 0 ? n.format(status.conversationsExtracted) : '—',
            ],
            ['customers', status.customersTotal > 0 ? n.format(status.customersTotal) : '—'],
            ['period', '—'],
            ['answers', n.format(status.knowledgeCandidateCount)],
          ].map(([key, value]) => (
            <div key={key} className={styles.reportStat} data-testid={`report-stat-${key}`}>
              <dd className={styles.reportFigure}>{value}</dd>
              <dt className={styles.reportLabel}>{t(`learn.stat.${key}`)}</dt>
            </div>
          ))}
        </dl>

        <div className={styles.reportCards}>
          <section className={styles.reportCard} title={t('learn.noImportData')}>
            <h3 className={styles.soFarTitle}>{t('learn.card.languages')}</h3>
            <p className={styles.timelineSub}>—</p>
          </section>
          <section className={styles.reportCard} title={t('learn.noImportData')}>
            <h3 className={styles.soFarTitle}>{t('learn.card.sound')}</h3>
            <p className={styles.timelineSub}>—</p>
          </section>
          <section className={styles.reportCard}>
            <h3 className={styles.soFarTitle}>{t('learn.card.customers')}</h3>
            <p className={styles.timelineSub} data-testid="report-customers">
              {status.customersAnalyzed > 0
                ? t('learn.customersRead', { count: n.format(status.customersAnalyzed) })
                : '—'}
            </p>
          </section>
        </div>

        <nav className={styles.reportTabs} aria-label={t('review.heading')}>
          {TABS.map((g) => (
            <Link
              key={g}
              href={href('report', status.id, g)}
              className={styles.reportTab}
              aria-current={g === current ? 'page' : undefined}
              data-testid={`report-tab-${g}`}
              scroll={false}
            >
              {t(`review.group.${g}`)} {n.format(inGroup(candidates, g).length)}
            </Link>
          ))}
        </nav>

        {shown.length === 0 ? (
          <p className={styles.timelineSub} data-testid="report-empty">
            {t('review.empty')}
          </p>
        ) : (
          <ul className={styles.reportGrid} title={t('review.evidenceNotTruth')}>
            {shown.map((c) => {
              const chip = chipOf(c);
              const variants = variantsOf(c);
              return (
                <li key={c.id} className={styles.reportItem} data-testid={`candidate-${c.id}`}>
                  <p className={styles.reportItemHead}>
                    <span
                      className={styles.reportChip}
                      data-tone={chip.tone}
                      title={
                        c.conflict
                          ? t('review.conflict')
                          : c.requiresLiveLookup
                            ? t('review.liveLookup')
                            : undefined
                      }
                    >
                      {chip.text}
                    </span>
                    {/* A count of nothing is not drawn: no "0 chats". */}
                    <span className={styles.reportItemMeta}>
                      {[
                        c.occurrenceCount > 0
                          ? t('learn.chats', { count: c.occurrenceCount })
                          : null,
                        c.conflict ? null : pct.format(c.confidence),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </p>
                  <p className={styles.reportQuestion}>{c.question}</p>
                  {c.conflict && variants.length > 1 ? (
                    <p className={styles.reportVariants}>
                      {variants.map((v) => (
                        <span key={v.key} className={styles.reportVariant}>
                          {v.answer}
                        </span>
                      ))}
                    </p>
                  ) : (
                    <p className={styles.reportAnswer}>{c.answer}</p>
                  )}
                  {groupOf(c) === 'needs_a_look' ? (
                    <p className={styles.reportActions}>
                      {c.conflict && variants.length > 1 ? (
                        variants.map((v) => (
                          <span
                            key={v.key}
                            className={styles.reportAction}
                            aria-disabled="true"
                            title={notLive}
                          >
                            {t('learn.use', { answer: v.answer.slice(0, 24) })}
                          </span>
                        ))
                      ) : (
                        <span className={styles.reportAction} aria-disabled="true" title={notLive}>
                          {t('review.approve')}
                        </span>
                      )}
                      <span className={styles.reportAction} aria-disabled="true" title={notLive}>
                        {t('learn.edit')}
                      </span>
                      <span className={styles.reportAction} aria-disabled="true" title={notLive}>
                        {c.conflict ? t('learn.skip') : t('review.reject')}
                      </span>
                    </p>
                  ) : null}
                </li>
              );
            })}
            {current === 'needs_a_look' && ready.length > 0 ? (
              <li className={styles.reportReady} data-testid="report-ready-card">
                <p className={styles.reportItemMeta}>
                  {t('learn.readyCard', { count: ready.length })}
                </p>
                {ready.slice(0, 2).map((c) => (
                  <p key={c.id} className={styles.reportReadyRow}>
                    <span className={styles.reportReadyQ}>{c.question}</span>
                    <span>{c.answer}</span>
                  </p>
                ))}
              </li>
            ) : null}
          </ul>
        )}
      </div>

      <footer className={drawer.drawerFoot}>
        <span
          className={styles.learnPrimary}
          aria-disabled="true"
          title={`${t('review.bulkSafe')} ${notLive}`}
          data-testid="report-bulk"
        >
          {t('learn.addReady', { count: bulk })}
        </span>
        <Link
          href={{ pathname: '/settings/channels', query: { panel: 'whatsapp' } }}
          className={drawer.drawerCancel}
          scroll={false}
        >
          {t('learn.later')}
        </Link>
        <span
          className={drawer.drawerFootNote}
          aria-disabled="true"
          title={`${t('review.rerunSafe')} ${notLive}`}
        >
          {t('learn.rerun')}
        </span>
      </footer>
    </>
  );
}
