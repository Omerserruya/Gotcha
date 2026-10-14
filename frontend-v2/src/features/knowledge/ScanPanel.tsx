'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState, useTransition } from 'react';

import {
  displayHost,
  SCAN_FAILURES,
  siteWasReadable,
  type ScanKnowledge,
  type ScanRun,
} from '@/api/contracts/workspace';
import { Globe } from 'lucide-react';

import { Button } from '@/design-system/primitives/button/Button';
import {
  acceptScanFields,
  readWorkspaceScan,
  startWorkspaceScan,
  type ScanStart,
} from '@/features/workspace/actions';

import styles from './ScanPanel.module.css';

/**
 * Scan again - screen 11b, on Studio · Knowledge since 2026-10-11 (Omer:
 * "move the website re-scan to Knowledge"). It sits with the website in
 * "Where it learns from", where 02 draws "Your website · scanned
 * automatically".
 *
 * ★ WHAT IT REFRESHES (auth 8d01252f): the business profile (name,
 *   description, address...) - the facts on Settings · Workspace - AND the
 *   knowledge documents the scan itself generated, listed above it. A
 *   document a person edited is kept as it is. When it is done the panel says
 *   what happened to those pages, in counts. The actions, and their permission
 *   (`settings:workspace:update`, the route's), are the workspace's.
 *
 * ★ A RUN, NOT A REQUEST (2026-10-14). A crawl and a model call take 25-40
 *   seconds; the browser and the BFF stopped waiting at 20, so every rescan
 *   read "did not run" while it finished. Now "Scan again" starts it, and the
 *   panel reads it every few seconds until it is done or failed. One still
 *   running when the page opens is followed from where it is.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * A RESCAN IS A CONVERSATION, NOT A BUTTON
 * ════════════════════════════════════════════════════════════════════════════
 * `POST /workspace/scan` returns three things, and a control that fired it and
 * showed none of them would discard the half the endpoint exists to produce:
 *
 *   applied   written silently, because the scan already owned those fields
 *   offer     proposals, each with the CURRENT value, the PROPOSED one, and
 *             WHY it was not taken
 *   reach     what the crawl could see, which decides whether any of it means
 *             anything
 *
 * ── THE OFFER REASONS ARE TWO DIFFERENT ADMISSIONS ──
 * *"You edited this, so it was left alone"* and *"nobody recorded who wrote
 * this, so it was left alone"* are not the same sentence, and only the first
 * is about something the merchant did. On this estate every offer is the
 * second, because the provenance map is empty everywhere.
 *
 * ── AND ACCEPTING MEANS SOMETHING PRECISE ──
 * It stamps the field `scan`-owned, so future scans refresh it without
 * asking. That is the consent being collected, and the screen says so before
 * the click rather than describing it as "use this value".
 */
/** How often a running rescan is read. */
export const SCAN_POLL_MS = 2_500;
/** Reads in a row that may fail before the panel stops following and says so. */
export const MAX_MISSED_READS = 3;

/** The pages' counts, in the order a person reads them; a zero is left out. */
const PAGE_COUNTS = ['created', 'updated', 'preserved', 'removed', 'failed', 'unchanged'] as const;

export function ScanPanel({
  domain,
  running = null,
}: {
  readonly domain: string | null;
  /** A rescan already running when the page opened: followed from there. */
  readonly running?: ScanRun | null;
}) {
  const t = useTranslations('knowledge.scan');
  /*
    02's banner sentence. The domain is named when we have one - "read from
    avivco.il" is a verifiable claim and "from your website" is not.
  */
  const host = domain ? displayHost(domain) : null;
  const intro = host ? t('intro.withSite', { domain: host }) : t('intro.noSite');
  const locale = useLocale();
  // Only a run started or followed HERE is shown: an old one's offers may be stale.
  const [run, setRun] = useState<ScanRun | null>(running);
  const [refused, setRefused] = useState<Extract<ScanStart, { ok: false }>['reason'] | null>(null);
  const [lost, setLost] = useState(false);
  const [acceptFailed, setAcceptFailed] = useState(false);
  const [accepted, setAccepted] = useState<readonly string[]>([]);
  const [taken, setTaken] = useState<{ accepted: number; skipped: number } | null>(null);
  const [isPending, startTransition] = useTransition();
  const isRunning = run?.status === 'running';

  /*
    Read until it ends - one read at a time, each a few seconds after the
    last answered. A read that fails is tried again; three in a row and the
    panel says it lost track rather than spinning forever. The server itself
    ends a run after three minutes (timed_out).
  */
  useEffect(() => {
    if (!isRunning) return;
    let stopped = false;
    let missed = 0;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      const next = await readWorkspaceScan();
      if (stopped) return;
      if (next === undefined) {
        missed += 1;
        if (missed >= MAX_MISSED_READS) {
          setLost(true);
          setRun(null);
          return;
        }
      } else if (next === null) {
        // The run is gone from the server: nothing left to follow.
        setLost(true);
        setRun(null);
        return;
      } else {
        missed = 0;
        setRun(next);
        if (next.status !== 'running') return;
      }
      timer = setTimeout(read, SCAN_POLL_MS);
    };
    timer = setTimeout(read, SCAN_POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [isRunning]);

  function scan() {
    setTaken(null);
    setRefused(null);
    setLost(false);
    setAcceptFailed(false);
    setAccepted([]);
    startTransition(async () => {
      const started = await startWorkspaceScan(locale);
      if (!started.ok) {
        setRefused(started.reason);
        return;
      }
      setRun(started.run);
    });
  }

  function accept(field: string) {
    startTransition(async () => {
      const outcome = await acceptScanFields([field]);
      if (!outcome) {
        setAcceptFailed(true);
        return;
      }
      setTaken({ accepted: outcome.accepted.length, skipped: outcome.skipped.length });
      // Drop the accepted row rather than re-running the scan: another crawl
      // to reflect a decision already made would cost a fetch and could
      // return different values, which reads as the click having changed
      // something it did not.
      setAccepted((was) => [...was, ...outcome.accepted]);
    });
  }

  const result = run?.status === 'done' ? run : null;
  const offers = result ? result.offer.filter((o) => !accepted.includes(o.field)) : [];

  return (
    <section id="scan" className={styles.scan} data-testid="scan">
      {/*
        02's banner: a pill row - the sentence and "Scan again" on the right.
        No "From website" legend here: there are no marked rows on this screen
        for it to explain, so the sentence names the marking instead. What a
        rescan will and will not do is said on the control itself, before it
        is pressed.
      */}
      <div className={styles.scanBanner} data-testid="scan-intro">
        <Globe className={styles.scanIcon} size={15} aria-hidden="true" />
        <span className={styles.scanIntro}>{intro}</span>
        <button
          type="button"
          className={styles.scanAgain}
          onClick={scan}
          disabled={isPending || isRunning}
          title={host ? t('beforeYouStart', { domain: host }) : undefined}
          data-testid="scan-run"
        >
          {isPending || isRunning ? t('running') : t('button')}
        </button>
      </div>
      {/*
        Said BEFORE the button. A rescan on this estate applies nothing and
        proposes everything, and somebody who expects it to "update my details
        from my site" should know that is not what will happen.
      */}

      {isRunning ? (
        <p className={styles.provenanceBasis} role="status" data-testid="scan-running">
          {t('runningLine')}
        </p>
      ) : null}

      {refused || acceptFailed ? (
        <p className={styles.scanRefusal} data-testid="scan-failed">
          {refused === 'forbidden' ? t('forbidden') : t('failed')}
        </p>
      ) : null}

      {lost ? (
        <p className={styles.scanRefusal} role="status" data-testid="scan-lost">
          {t('lost')}
        </p>
      ) : null}

      {run?.status === 'failed' ? (
        <p className={styles.scanRefusal} data-testid="scan-refusal">
          {/*
            Each failure its own sentence. "You have not told us your website"
            and "the site did not answer" need different actions from the
            reader, and one "scan failed" would serve neither.
          */}
          {(SCAN_FAILURES as readonly string[]).includes(run.reason ?? '')
            ? t(`refusal.${run.reason as (typeof SCAN_FAILURES)[number]}`)
            : t('failed')}
        </p>
      ) : null}

      {result ? (
        <div data-testid="scan-result">
          {/*
            ★ The caveat that appears because a measurement says so.
            `distinctTextPages === 1` means every path answered with the same
            page. Everything proposed below was inferred from a login screen,
            and saying so is the difference between information and wallpaper.
          */}
          {!siteWasReadable(result.reach) ? (
            <p className={styles.scanUnreadable} data-testid="scan-unreadable">
              {t('unreadable')}
            </p>
          ) : null}

          <p className={styles.provenanceLead} data-testid="scan-applied">
            {result.applied.length > 0
              ? t('applied', { count: result.applied.length })
              : t('appliedNone')}
          </p>

          {result.knowledge ? <PagesLine knowledge={result.knowledge} /> : null}

          {result.offer.length === 0 && result.applied.length === 0 && !pagesChanged(result) ? (
            <p className={styles.provenanceBasis} data-testid="scan-no-changes">
              {t('noChanges')}
            </p>
          ) : null}

          {offers.length > 0 ? (
            <div data-testid="scan-offers">
              <p className={styles.provenanceHeading}>{t('offerHeading')}</p>
              <p className={styles.provenanceBasis} data-testid="scan-offer-intro">
                {t('offerIntro')}
              </p>

              <ul className={styles.scanOffers}>
                {offers.map((offer) => (
                  <li key={offer.field} className={styles.scanOffer} data-testid="scan-offer">
                    <p className={styles.provenanceBasis} data-testid="scan-offer-because">
                      {t(`because.${offer.because}`)}
                    </p>
                    <p className={styles.scanValue}>
                      <span className={styles.scanValueLabel}>{t('currentLabel')}</span>
                      <span data-testid="scan-offer-current">{String(offer.current ?? '-')}</span>
                    </p>
                    <p className={styles.scanValue}>
                      <span className={styles.scanValueLabel}>{t('proposedLabel')}</span>
                      <span data-testid="scan-offer-proposed">{String(offer.proposed ?? '-')}</span>
                    </p>
                    <Button
                      size="sm"
                      disabled={isPending}
                      data-testid={`scan-accept-${offer.field}`}
                      onClick={() => accept(offer.field)}
                    >
                      {t('accept')}
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {taken ? (
        <p className={styles.provenanceBasis} data-testid="scan-taken">
          {t('accepted', { count: taken.accepted })}
          {taken.skipped > 0 ? ` ${t('skipped', { count: taken.skipped })}` : ''}
        </p>
      ) : null}
    </section>
  );
}

/**
 * What the rescan did to the pages it generated, in counts - "2 pages
 * updated, 1 kept because you edited it". Nothing when nothing was counted.
 */
function PagesLine({ knowledge }: { readonly knowledge: ScanKnowledge }) {
  const t = useTranslations('knowledge.scan.pages');
  const parts = PAGE_COUNTS.filter((key) => knowledge[key] > 0).map((key) =>
    t(key, { count: knowledge[key] }),
  );
  if (parts.length === 0) return null;
  return (
    <p className={styles.provenanceLead} data-testid="scan-knowledge">
      {`${parts.join(', ')}.`}
    </p>
  );
}

/** Did the rescan add, change or remove any page? Then "nothing to change" would be false. */
function pagesChanged(run: ScanRun): boolean {
  const k = run.knowledge;
  return k !== null && k.created + k.updated + k.removed > 0;
}
