'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';

import { siteHost } from '@/api/contracts/onboarding';
import { isLiveJob, type DiscoverJob, type JobEvent } from '@/api/contracts/onboarding-v2';
import { Link, useRouter } from '@/i18n/navigation';

import { stepHref } from './preview';
import { readScan, retryScan } from './scan-actions';
import { saveStep } from './step-actions';
import { StepLink } from './StepLink';
import { ScanChips, ScanFeed } from './ScanFeed';
import styles from './Onboarding.module.css';

/** How often the screen reads the job while it runs (Backend: about once a second). */
export const POLL_MS = 1000;
/** After the job finishes, how long "Done" holds before moving on by itself. */
export const ADVANCE_MS = 1500;
/** The step after this one: connect your systems. */
export const nextStep = (preview: boolean) => stepHref('/onboarding/systems', preview);

/**
 * Did the job get anywhere before it stopped? Pages read, or anything found.
 * Then the address is not the problem, and what was found can be used.
 */
export function gotSomewhere(job: DiscoverJob): boolean {
  const found = job.found;
  return (
    job.counts.pagesRead > 0 ||
    found.platform !== null ||
    found.productCount > 0 ||
    found.productsSampled > 0 ||
    found.policies.length > 0 ||
    found.faqCount > 0 ||
    found.contact ||
    found.hours ||
    found.brand ||
    found.tools.length > 0
  );
}
/** A host longer than this does not fit the headline at its size. */
const LONG_HOST = 28;
const FAILED_CODES = ['site_unreachable', 'stage_failed', 'nothing_learned'];

/** Events merged by sequence: a poll that answers twice never draws a line twice. */
export function mergeEvents(
  held: readonly JobEvent[],
  next: readonly JobEvent[],
): readonly JobEvent[] {
  const seen = new Set(held.map((event) => event.seq));
  return [...held, ...next.filter((event) => !seen.has(event.seq))];
}

/**
 * 00e - Reading it, rebuilt on the site job (Omer, 2026-10-23): a rolling
 * feed of what is REALLY happening, the stage in words, and what was found
 * so far. No percentage: the job reports stages and events, not a fraction.
 *
 * The job runs on the server whether or not this tab stays open. A reload
 * reads it again from the start (`since` 0), so the feed and every chip come
 * back at once. A job that stopped (FAILED, or STALLED with no heartbeat)
 * says why, with a way to carry on from where it stopped.
 */
export function ReadingStep({
  initial,
  preview = false,
}: {
  /** `null`: the first look failed - said, and read again. */
  readonly initial: DiscoverJob | null;
  /** Read-only: the links keep `?preview=1`. */
  readonly preview?: boolean;
}) {
  const t = useTranslations('onboarding.scan');
  const router = useRouter();
  const [job, setJob] = useState(initial);
  const [events, setEvents] = useState<readonly JobEvent[]>(initial?.events ?? []);
  const [missed, setMissed] = useState(initial === null);
  const [retrying, setRetrying] = useState<'idle' | 'working' | 'failed'>('idle');
  const since = useRef(Math.max(0, ...(initial?.events ?? []).map((event) => event.seq)));
  const jobId = useRef(initial?.jobId ?? null);
  const live = job === null || isLiveJob(job);
  // Finished while you watched: it moves on. Finished before you came (the way back
  // from step 2 lands here): it stays, with Continue - it never bounces you forward.
  const arrivedLive = useRef(initial === null || isLiveJob(initial));

  useEffect(() => {
    if (!live) return;
    const timer = setTimeout(() => {
      void readScan(since.current).then((read) => {
        if (!read.ok) {
          if (read.reason === 'none') router.replace(stepHref('/onboarding/website', preview));
          else setMissed(true);
          return;
        }
        setMissed(false);
        // A different job superseded this one: its feed starts over.
        const fresh = read.job.jobId !== jobId.current;
        jobId.current = read.job.jobId;
        setEvents((held) => (fresh ? read.job.events : mergeEvents(held, read.job.events)));
        since.current = Math.max(fresh ? 0 : since.current, ...read.job.events.map((e) => e.seq));
        setJob(read.job);
      });
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [live, job, missed, router, preview]);

  const done = job?.status === 'COMPLETE';
  useEffect(() => {
    if (!done || preview || !arrivedLive.current) return;
    // Saved first, so a reload after the move resumes at systems.
    const timer = setTimeout(() => {
      void saveStep('systems')
        .catch(() => false)
        .then(() => router.push(nextStep(false)));
    }, ADVANCE_MS);
    return () => clearTimeout(timer);
  }, [done, preview, router]);

  const retry = async () => {
    setRetrying('working');
    const ok = await retryScan().catch(() => false);
    setRetrying(ok ? 'idle' : 'failed');
    // Back to polling: the job says RUNNING again on its next read.
    if (ok && job) setJob({ ...job, status: 'QUEUED' });
  };

  const host = job?.domain ? siteHost(job.domain) : null;
  const status = job?.status ?? 'QUEUED';
  const stopped = status === 'FAILED' || status === 'STALLED';
  // Stopped partway: never blame the address when pages were read or facts found.
  const partway = stopped && job !== null && gotSomewhere(job);
  const why = partway
    ? t('failed.partway')
    : status === 'STALLED'
      ? t('failed.stalled')
      : t(`failed.${FAILED_CODES.includes(job?.error?.code ?? '') ? job?.error?.code : 'other'}`);

  return (
    <div className={styles.reading} data-status={status} data-testid="reading">
      <h1
        className={styles.title}
        data-long={host && host.length > LONG_HOST ? '' : undefined}
        data-testid="reading-title"
      >
        {host
          ? t.rich('title', { host, ltr: (chunks) => <bdi dir="ltr">{chunks}</bdi> })
          : t('titleNoHost')}
      </h1>
      <p className={styles.subtitle} role="status" data-testid="reading-stage">
        {status === 'RUNNING' ? (
          <>
            <span className={styles.trackRunning} aria-hidden="true" />{' '}
            {job?.stage ? t(`stages.${job.stage}`) : t('status.QUEUED')}
          </>
        ) : (
          t(`status.${status}`)
        )}
      </p>

      {job && job.counts.pagesPlanned > 0 ? (
        <p className={styles.quiet} data-testid="reading-counts">
          {t('counts', { read: job.counts.pagesRead, planned: job.counts.pagesPlanned })}
          {job.counts.pagesBlocked > 0
            ? ` · ${t('countsBlocked', { count: job.counts.pagesBlocked })}`
            : null}
        </p>
      ) : null}

      <ScanFeed events={events} />
      {job ? <ScanChips found={job.found} /> : null}

      {job?.found.blocked ? (
        <p className={styles.notYet} data-testid="reading-blocked">
          {t('blocked')}
        </p>
      ) : null}

      {missed && live ? (
        <p className={styles.quiet} data-testid="reading-missed">
          {t('missed')}
        </p>
      ) : null}

      {stopped ? (
        <div className={styles.problem} role="alert" data-testid="reading-stopped">
          <p>{why}</p>
          <span className={styles.actions}>
            <button
              type="button"
              className={styles.primary}
              onClick={retry}
              disabled={retrying === 'working' || preview}
              data-testid="reading-retry"
            >
              {retrying === 'working' ? t('retrying') : t('retry')}
            </button>
            {partway ? (
              <StepLink
                href={nextStep(preview)}
                step="systems"
                preview={preview}
                className={styles.secondary}
                data-testid="reading-with-found"
              >
                {t('withFound')}
              </StepLink>
            ) : (
              <Link
                href={stepHref('/onboarding/website', preview)}
                className={styles.secondary}
                data-testid="reading-change"
              >
                {t('change')}
              </Link>
            )}
          </span>
          {retrying === 'failed' ? (
            <p className={styles.quiet} data-testid="reading-retry-failed">
              {t('retryFailed')}
            </p>
          ) : null}
        </div>
      ) : null}

      {done ? (
        <span className={styles.actions}>
          <StepLink
            href={nextStep(preview)}
            step="systems"
            preview={preview}
            className={styles.primary}
            data-testid="reading-next"
          >
            {t('next')}
          </StepLink>
        </span>
      ) : null}
    </div>
  );
}
