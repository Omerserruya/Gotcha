'use client';

import { Check, Circle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { readProgress, siteHost, type Discovery } from '@/api/contracts/onboarding';
import { Link } from '@/i18n/navigation';

import type { ReadingRead } from './load-onboarding';
import { readReading } from './onboarding-actions';
import styles from './Onboarding.module.css';

/** How often 00e looks again while the read runs. A read takes about two minutes. */
export const POLL_MS = 3000;
/** How long a read may take to show it has started before 00e says it did not. */
export const START_WAIT_MS = 60_000;

const TRACKS = ['products', 'policies', 'places', 'voice'] as const;
const FEED = 6;

export type ReadingPhase = 'starting' | 'reading' | 'done' | 'failed';

/**
 * Where the read is. A row older than this visit's start (`since`) is the
 * LAST read - this one has not reached it yet.
 */
export function readingPhase(discovery: Discovery | null, since: string | null): ReadingPhase {
  if (!discovery) return 'starting';
  const fresh = since === null || (discovery.updatedAt ?? '') >= since;
  if (discovery.status === 'SCANNING') return 'reading';
  if (!fresh || discovery.status === 'PENDING') return 'starting';
  return discovery.status === 'COMPLETE' ? 'done' : 'failed';
}

/**
 * 00e - Reading it (design 6). The read runs on the backend whether or not
 * this tab stays open; this screen looks at its row every few seconds until
 * it settles.
 *
 * ★ ONLY PAGES HAS A COUNT. The route reports its phase and the pages it read,
 *   not products / policies / places / voice: those four tiles say whether
 *   the read is still going, and say they are not counted - never a number.
 * ★ "Found just now" is what the read wrote to Knowledge, each with its page,
 *   and the gaps it reported.
 */
export function ReadingStep({
  initial,
  since,
}: {
  /** `null`: the first look failed. */
  readonly initial: ReadingRead | null;
  readonly since: string | null;
}) {
  const t = useTranslations('onboarding.reading');
  const [read, setRead] = useState(initial);
  const [missed, setMissed] = useState(initial === null);
  const [waitedOut, setWaitedOut] = useState(false);
  const discovery = read?.discovery ?? null;
  const phase = readingPhase(discovery, since);
  const settled = phase === 'done' || phase === 'failed' || waitedOut;

  useEffect(() => {
    if (phase !== 'starting') return;
    const timer = setTimeout(() => setWaitedOut(true), START_WAIT_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  useEffect(() => {
    if (settled) return;
    const timer = setTimeout(() => {
      void readReading().then((next) => {
        setMissed(next === null);
        if (next) setRead(next);
      });
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [settled, read, missed]);

  const host = discovery?.websiteDomain ? siteHost(discovery.websiteDomain) : null;
  const progress = phase === 'starting' ? 0 : (readProgress(discovery) ?? 0);
  const crawl = phase === 'starting' ? null : (discovery?.crawl ?? null);
  const facts = (read?.facts ?? []).filter((f) => since === null || (f.updatedAt ?? '') >= since);
  const gaps = phase === 'done' ? (discovery?.gaps ?? []) : [];
  const state = waitedOut && phase === 'starting' ? 'notStarted' : phase;

  return (
    <div className={styles.reading} data-phase={state} data-testid="reading">
      <h1 className={styles.title}>
        {host ? t.rich('title', { host: () => <bdi dir="ltr">{host}</bdi> }) : t('titleNoHost')}
      </h1>
      <p className={styles.subtitle} data-testid="reading-lead" role="status">
        {t(`lead.${state}`)}
      </p>
      <div
        className={styles.bar}
        role="progressbar"
        aria-label={t('progress')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
        data-testid="reading-progress"
      >
        <span className={styles.barFill} style={{ inlineSize: `${progress * 100}%` }} />
      </div>

      <ul className={styles.tracks}>
        <li className={styles.track} data-testid="reading-track-pages">
          <span className={styles.trackHead}>
            {t('tracks.pages')}
            <TrackState phase={phase} />
          </span>
          <span className={styles.trackCount}>{crawl ? crawl.pagesRead : ' '}</span>
          <span className={styles.trackSub}>
            {crawl ? t('ofPages', { requested: crawl.requested }) : t('counting')}
          </span>
        </li>
        {TRACKS.map((track) => (
          <li key={track} className={styles.track} data-testid={`reading-track-${track}`}>
            <span className={styles.trackHead}>
              {t(`tracks.${track}`)}
              <TrackState phase={phase} />
            </span>
            <span className={styles.trackSub}>{t('notCounted')}</span>
          </li>
        ))}
      </ul>

      <section className={styles.feed} aria-label={t('found')} data-testid="reading-feed">
        <span className={styles.feedHead}>
          <span className={styles.feedDot} aria-hidden="true" />
          {t('found')}
        </span>
        {read?.facts === null ? (
          <p className={styles.feedQuiet}>{t('factsUnread')}</p>
        ) : facts.length === 0 && gaps.length === 0 ? (
          <p className={styles.feedQuiet}>
            {phase === 'done' ? t('nothingWritten') : t('factsSoon')}
          </p>
        ) : (
          <ul className={styles.feedRows}>
            {facts.slice(0, FEED).map((fact) => (
              <li key={fact.id} className={styles.feedRow}>
                <Check size={13} aria-hidden="true" className={styles.feedCheck} />
                <span className={styles.feedText}>
                  <bdi dir="auto">{fact.title}</bdi>
                </span>
                {fact.path ? (
                  <bdi dir="ltr" className={styles.feedPath}>
                    {fact.path}
                  </bdi>
                ) : null}
              </li>
            ))}
            {gaps.slice(0, 3).map((gap) => (
              <li key={gap.label} className={styles.feedRow} data-gap="">
                <Circle size={13} aria-hidden="true" className={styles.feedGap} />
                <span className={styles.feedText}>
                  <bdi dir="auto">{gap.label}</bdi>
                </span>
                <span className={styles.feedPath}>{t('notFound')}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {missed && !settled ? (
        <p className={styles.quiet} data-testid="reading-missed">
          {t('missed')}
        </p>
      ) : null}

      {phase === 'done' ? (
        <span className={styles.actions}>
          <Link href="/onboarding/learned" className={styles.primary} data-testid="reading-next">
            {t('next')}
          </Link>
        </span>
      ) : phase === 'failed' || state === 'notStarted' ? (
        <span className={styles.actions}>
          <Link href="/onboarding/website" className={styles.secondary} data-testid="reading-again">
            {t('again')}
          </Link>
        </span>
      ) : null}
    </div>
  );
}

function TrackState({ phase }: { readonly phase: ReadingPhase }) {
  if (phase === 'done') return <Check size={13} className={styles.trackDone} aria-hidden="true" />;
  if (phase === 'reading') return <span className={styles.trackRunning} aria-hidden="true" />;
  return null;
}
