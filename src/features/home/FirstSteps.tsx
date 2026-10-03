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
    <>
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

        {/*
        01c's Go live: locked, with what holds it, until the server says it is
        eligible — and then drawn, not live: going live is a write that puts
        GOTCHA in front of real customers.
      */}
        <div className={styles.goLive} data-testid="go-live">
          <div className={styles.goLiveText}>
            <span className={styles.goLiveTitle}>{t('goLive.title')}</span>
            <span className={styles.goLiveBody}>{t('goLive.body')}</span>
          </div>
          <span
            className={styles.goLiveButton}
            aria-disabled="true"
            data-testid="go-live-button"
            title={
              setup.goLive?.eligible
                ? t('goLive.notYet')
                : t('goLive.lockedBy', {
                    steps:
                      (setup.goLive?.blockedBy ?? []).map((id) => stepTitle(id, t)).join(', ') ||
                      '—',
                  })
            }
          >
            {setup.goLive?.eligible ? t('goLive.go') : t('goLive.locked')}
          </span>
        </div>
      </section>
      {/* True: once live, Home's face is the ordinary one (`homeFace`). */}
      <p className={styles.foot} data-testid="first-steps-foot">
        {t('foot')}
      </p>
    </>
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
          <p className={styles.rowBodyNext}>{body}</p>
        </div>
        <div className={styles.rowActions}>
          <StepAction id={step.id} label={action} className={styles.actionPrimary} t={t} />
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
      <div className={[styles.rowText, styles.rowLine].join(' ')}>
        <span className={styles.rowTitle}>{title}</span>
        <span className={styles.rowBody} title={blocker ? undefined : body}>
          {blocker ? afterStep(blocker, t) : body}
        </span>
      </div>
      <StepAction id={step.id} label={action} className={styles.actionSecondary} t={t} />
    </li>
  );
}

/** A link where a screen completes the step; drawn, with why, where none does. */
function StepAction({
  id,
  label,
  className,
  t,
}: {
  id: string;
  label: string;
  className: string | undefined;
  t: Translate;
}) {
  const href = stepDestination(id);
  return href ? (
    <Link href={href} className={className} data-testid={`step-action-${id}`}>
      {label}
    </Link>
  ) : (
    <span
      className={className}
      aria-disabled="true"
      title={t('noScreen')}
      data-testid={`step-action-${id}`}
    >
      {label}
    </span>
  );
}

/** "After you hire your first AI employee." — a sentence per blocker. */
function afterStep(id: string, t: Translate): string {
  const key = stepCopyKey(id);
  return key ? t(`step.${key}.after`) : t('blockedBy', { step: id });
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
  const read = t('ingest', { pages: ingest.pagesRead, drafted: ingest.answersDrafted });
  /*
    The answers waiting on a person, counted from the TRUE total —
    `pendingTopics` is a sample. This lived on `hire_employee`, which the
    server completes when an employee exists, not when answers are confirmed.
  */
  if (ingest.answersNeedingConfirmation === 0) return ` — ${read}`;
  // The count from the total; the names (three) from the sample.
  const topics = ingest.pendingTopics.slice(0, 3).map((entry) => entry.topic);
  const waiting = t('ingestWaiting', { count: ingest.answersNeedingConfirmation });
  return topics.length > 0
    ? ` — ${read} · ${waiting}: ${topics.join(', ')}`
    : ` — ${read} · ${waiting}`;
}

function clockTime(at: string, format: Format): string {
  const when = new Date(at);
  // 24-hour, as the rest of the product writes a time ("09:02").
  return Number.isNaN(when.getTime())
    ? ''
    : format.dateTime(when, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}
