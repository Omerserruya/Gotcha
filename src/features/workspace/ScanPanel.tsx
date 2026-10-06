'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { displayHost, siteWasReadable, type ScanResult } from '@/api/contracts/workspace';
import { Globe } from 'lucide-react';

import { Button } from '@/design-system/primitives/button/Button';

import { acceptScanFields, runWorkspaceScan } from './actions';
import styles from './Workspace.module.css';

/**
 * Scan again - screen 11b.
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
export function ScanPanel({ domain }: { readonly domain: string | null }) {
  const t = useTranslations('workspace.scan');
  const tWorkspace = useTranslations('workspace');
  /*
    02's banner sentence. The domain is named when we have one - "filled in
    from avivco.il" is a verifiable claim and "from your website" is not.
  */
  const host = domain ? displayHost(domain) : null;
  const intro = host ? tWorkspace('intro.withSite', { domain: host }) : tWorkspace('intro.noSite');
  const [result, setResult] = useState<ScanResult | null>(null);
  const [failed, setFailed] = useState(false);
  const [taken, setTaken] = useState<{ accepted: number; skipped: number } | null>(null);
  const [isPending, startTransition] = useTransition();

  function scan() {
    setTaken(null);
    setFailed(false);
    startTransition(async () => {
      const next = await runWorkspaceScan();
      if (next === null) setFailed(true);
      setResult(next);
    });
  }

  function accept(field: string) {
    startTransition(async () => {
      const outcome = await acceptScanFields([field]);
      if (!outcome) {
        setFailed(true);
        return;
      }
      setTaken({ accepted: outcome.accepted.length, skipped: outcome.skipped.length });
      // Drop the accepted row rather than re-running the scan: another crawl
      // to reflect a decision already made would cost a fetch and could
      // return different values, which reads as the click having changed
      // something it did not.
      setResult((prev) =>
        prev && prev.ok
          ? { ...prev, offer: prev.offer.filter((o) => !outcome.accepted.includes(o.field)) }
          : prev,
      );
    });
  }

  return (
    <section id="scan" className={styles.scan} data-testid="scan">
      {/*
        02's banner: a pill row - the sentence, the "From website" legend the
        rows use, and "Scan again" on the right. What a rescan will and will
        not do is said on the control itself, before it is pressed.
      */}
      <div className={styles.scanBanner} data-testid="facts-intro">
        <Globe className={styles.scanIcon} size={15} aria-hidden="true" />
        <span className={styles.scanIntro}>{intro}</span>
        <span className={styles.fromWebsite}>{t('legend')}</span>
        <button
          type="button"
          className={styles.scanAgain}
          onClick={scan}
          disabled={isPending}
          title={host ? t('beforeYouStart', { domain: host }) : undefined}
          data-testid="scan-run"
        >
          {isPending ? t('running') : t('button')}
        </button>
      </div>
      {/*
        Said BEFORE the button. A rescan on this estate applies nothing and
        proposes everything, and somebody who expects it to "update my details
        from my site" should know that is not what will happen.
      */}

      {failed ? (
        <p className={styles.scanRefusal} data-testid="scan-failed">
          {t('failed')}
        </p>
      ) : null}

      {result && !result.ok ? (
        <p className={styles.scanRefusal} data-testid="scan-refusal">
          {/*
            Five refusals, five sentences. "You have not told us your website"
            and "the site did not answer" need different actions from the
            reader, and one "scan failed" would serve neither.
          */}
          {t(`refusal.${result.reason}`)}
        </p>
      ) : null}

      {result?.ok ? (
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

          {result.offer.length === 0 && result.applied.length === 0 ? (
            <p className={styles.provenanceBasis} data-testid="scan-no-changes">
              {t('noChanges')}
            </p>
          ) : null}

          {result.offer.length > 0 ? (
            <div data-testid="scan-offers">
              <p className={styles.provenanceHeading}>{t('offerHeading')}</p>
              <p className={styles.provenanceBasis} data-testid="scan-offer-intro">
                {t('offerIntro')}
              </p>

              <ul className={styles.scanOffers}>
                {result.offer.map((offer) => (
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
