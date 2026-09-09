import { getFormatter, getTranslations } from 'next-intl/server';

import type { KnowledgeIngest, SetupStatus, SetupStep } from '@/api/contracts/setup';
import { Link } from '@/i18n/navigation';

import styles from './FirstSteps.module.css';
import { nextStep, setupProgress, stepCopyKey, stepDestination } from './first-steps';

/**
 * "First steps" — screen 01c.
 *
 * Home in its first state, not a separate onboarding page: same shell, same
 * command box, one block beneath it. A snapshot of zero and an empty queue say
 * nothing, so this takes their place until the workspace goes live.
 *
 * Steps are ordered by what unblocks GOTCHA, and exactly one is ever "next" —
 * both decided by the server. Recomputing either here would let this block and
 * Settings disagree about what to do now.
 */
export async function FirstSteps({
  setup,
  ingest,
}: {
  setup: SetupStatus;
  /** Null when no scan has run. Folded into the knowledge step's line. */
  ingest: KnowledgeIngest;
}) {
  const t = await getTranslations('home.firstSteps');
  const format = await getFormatter();

  const progress = setupProgress(setup);
  const next = nextStep(setup);

  return (
    <section className={styles.block}>
      <div className={styles.header}>
        <h2 className={styles.title}>{t('title')}</h2>
        <span className={styles.progressText}>
          {progress.isComplete
            ? t('allDone')
            : t('progress', { done: progress.done, minutes: progress.minutesLeft })}
        </span>
        {/*
          The design offers "Hide"; dismissal has no backend flag to persist it,
          and a hide that reappears on the next load is worse than none. So the
          label leads where the steps live instead of pretending to remember.
        */}
        <Link href="/settings" className={styles.hide}>
          {t('hide')}
        </Link>
      </div>

      {/* One segment per step: progress you can count, not a percentage. */}
      <div className={styles.strip} aria-hidden="true">
        {setup.steps.map((step) => (
          <span
            key={step.id}
            className={[
              styles.segment,
              step.state === 'done' ? styles.segmentDone : '',
              step.state === 'next' ? styles.segmentNext : '',
            ]
              .join(' ')
              .trim()}
          />
        ))}
      </div>

      <ol className={styles.list}>
        {setup.steps.map((step, index) => (
          <Row
            key={step.id}
            step={step}
            position={index + 1}
            isNext={next?.id === step.id}
            ingest={ingest}
            t={t}
            format={format}
          />
        ))}
      </ol>

      <p className={styles.footnote}>
        {setup.goLive?.eligible ? t('goLiveReady') : t('goLiveBlocked')}
        {setup.trial?.daysRemaining != null
          ? ` · ${t('trial', { days: setup.trial.daysRemaining })}`
          : ''}
      </p>
    </section>
  );
}

type Translate = Awaited<ReturnType<typeof getTranslations>>;
type Format = Awaited<ReturnType<typeof getFormatter>>;

function Row({
  step,
  position,
  isNext,
  ingest,
  t,
  format,
}: {
  step: SetupStep;
  position: number;
  isNext: boolean;
  ingest: KnowledgeIngest;
  t: Translate;
  format: Format;
}) {
  const key = stepCopyKey(step.id);
  // An id nobody has written copy for is shown by its own id rather than
  // hidden: a step missing from the list changes what setup appears to involve.
  const title = key ? t(`step.${key}.title`) : step.id;

  if (step.state === 'done') {
    return (
      <li className={[styles.row, styles.rowDone].join(' ')}>
        <span className={[styles.badge, styles.badgeDone].join(' ')} aria-hidden="true">
          ✓
        </span>
        <span className={[styles.rowText, styles.doneText].join(' ')}>
          {title}
          {ingestSuffix(step, ingest, t)}
        </span>
        {step.completedAt ? (
          <time className={styles.doneTime} dateTime={step.completedAt}>
            {clockTime(step.completedAt, format)}
          </time>
        ) : null}
      </li>
    );
  }

  const body = key ? t(`step.${key}.body`) : '';
  const action = key ? t(`step.${key}.action`) : t('step.connect_channel.action');

  if (isNext) {
    return (
      <li className={[styles.row, styles.rowNext].join(' ')}>
        <span className={[styles.badge, styles.badgeNext].join(' ')} aria-hidden="true">
          {position}
        </span>
        <div className={styles.rowText}>
          <div className={styles.nextHeading}>
            <span className={styles.rowTitleNext}>{title}</span>
            <span className={styles.nextChip}>{t('next')}</span>
          </div>
          <p className={styles.rowBodyNext}>{pendingLine(step, ingest, t) ?? body}</p>
        </div>
        <div className={styles.rowActions}>
          <Link href={stepDestination(step.id)} className={styles.actionPrimary}>
            {action}
          </Link>
          {step.estimateMinutes > 0 ? (
            <span className={styles.estimate}>
              {t('estimate', { minutes: step.estimateMinutes })}
            </span>
          ) : null}
        </div>
      </li>
    );
  }

  const blocker = step.blockedBy[0];

  return (
    <li
      className={[styles.row, step.state === 'blocked' ? styles.rowBlocked : ''].join(' ').trim()}
    >
      <span className={styles.badge} aria-hidden="true">
        {position}
      </span>
      <div className={styles.rowText}>
        <div className={styles.rowTitle}>{title}</div>
        <div className={styles.rowBody}>
          {blocker ? t('blocked', { step: stepTitle(blocker, t) }) : body}
        </div>
      </div>
      <Link href={stepDestination(step.id)} className={styles.actionSecondary}>
        {action}
      </Link>
    </li>
  );
}

function stepTitle(id: string, t: Translate): string {
  const key = stepCopyKey(id);
  return key ? t(`step.${key}.title`) : id;
}

/**
 * The scan result, folded into the knowledge step once it is done.
 *
 * "avivco.il read, 214 pages, 38 answers drafted" — the number is the
 * reassurance. "We read your site" says nothing without how much of it.
 */
function ingestSuffix(step: SetupStep, ingest: KnowledgeIngest, t: Translate): string {
  if (step.id !== 'add_knowledge' || !ingest) return '';
  return ` — ${t('ingest', { pages: ingest.pagesRead, drafted: ingest.answersDrafted })}`;
}

/**
 * What is still waiting on a person, named.
 *
 * `pendingTopics` is a sample; `answersNeedingConfirmation` is the true total,
 * and the two must not be confused — the count comes from the total, the names
 * from the sample.
 */
function pendingLine(step: SetupStep, ingest: KnowledgeIngest, t: Translate): string | null {
  if (step.id !== 'hire_employee' || !ingest || ingest.answersNeedingConfirmation === 0)
    return null;
  const topics = ingest.pendingTopics.slice(0, 3).map((entry) => entry.topic);
  if (topics.length === 0) return null;
  return t('ingestPending', {
    count: ingest.answersNeedingConfirmation,
    topics: topics.join(', '),
  });
}

function clockTime(at: string, format: Format): string {
  const when = new Date(at);
  return Number.isNaN(when.getTime()) ? '' : format.dateTime(when, { timeStyle: 'short' });
}
