'use client';

import { FileText, Globe, Languages, MessageCircle, ShoppingBag } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { languageNames, siteHost, type Discovery } from '@/api/contracts/onboarding';
import { industryReading } from '@/api/contracts/workspace';
import {
  UnavailableAction,
  UnavailableItem,
} from '@/design-system/primitives/unavailable/Unavailable';
import { InstagramGlyph } from '@/features/inbox/channel-marks';
import { useRouter } from '@/i18n/navigation';
import { brandMark, brandName } from '@/lib/brand-mark';

import type { GuessSource } from './load-onboarding';
import { startReading } from './onboarding-actions';
import styles from './Onboarding.module.css';
import { stepHref } from './preview';

/** A description longer than this is a paragraph, not the line beside a name. */
const KIND_MAX = 60;

/**
 * 00d - Your website (design 6). The guess is confirmed, not typed; nothing
 * is read until "Yes, read it". A different address, or none guessed, opens
 * the field. What the card says it found is only what a scan of THIS site
 * already found - before any scan it names the site and nothing else.
 *
 * ★ "No website?" - Instagram, a catalogue file, five questions - has no
 *   route yet: drawn, and it says so.
 */
export function WebsiteStep({
  guess,
  email,
  business,
  discovery,
  preview = false,
}: {
  readonly guess: { readonly host: string; readonly from: GuessSource } | null;
  readonly email: string | null;
  readonly business: string | null;
  readonly discovery: Discovery | null;
  /** Read-only: reading a site is a write, drawn as a status. */
  readonly preview?: boolean;
}) {
  const t = useTranslations('onboarding.website');
  const tn = useTranslations('onboarding');
  const tIndustry = useTranslations('workspace.business.industryName');
  const locale = useLocale();
  const router = useRouter();
  const [typing, setTyping] = useState(guess === null);
  const [address, setAddress] = useState('');
  const [refused, setRefused] = useState(false);
  const [isStarting, start] = useTransition();

  const read = (host: string) =>
    start(async () => {
      setRefused(false);
      const since = new Date().toISOString();
      if (await startReading(host, locale)) {
        router.push(stepHref('/onboarding/reading', preview, { since }));
      } else setRefused(true);
    });

  // A scan's findings belong on the card only when they are about this site.
  const found = guess && discovery && siteHost(discovery.websiteDomain ?? '') === guess.host;
  const platform = found ? discovery.technology?.platform?.name || null : null;
  const languages = found ? languageNames(discovery.brand?.languages ?? [], locale) : null;
  // What it is, in words: the read's own short description, else the industry by its name.
  const summary = found ? discovery.business?.summary?.trim() : null;
  const reading = found ? industryReading(discovery.business?.industry) : null;
  const industry =
    summary && summary.length <= KIND_MAX
      ? summary
      : reading === null
        ? null
        : 'code' in reading
          ? tIndustry(reading.code)
          : reading.text;
  const name = business ? brandName(business) : null;
  const typed = siteHost(address);

  return (
    <div className={styles.website}>
      <h1 className={styles.title}>{guess && !typing ? t('title') : t('askTitle')}</h1>
      <p className={styles.subtitle} data-testid="website-from">
        {guess && !typing
          ? guess.from === 'email' && email
            ? t('fromEmail', { email })
            : t(`from.${guess.from === 'email' ? 'profile' : guess.from}`)
          : t('askLead')}
      </p>

      {guess && !typing ? (
        <>
          <div className={styles.site} data-testid="website-card">
            <span className={styles.siteBar}>
              <span className={styles.siteDots} aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <bdi dir="ltr" className={styles.siteHost}>
                {guess.host}
              </bdi>
            </span>
            <span className={styles.siteBanner}>
              {business ? (
                <span className={styles.wordmark} data-testid="website-wordmark">
                  <bdi dir="auto">{brandMark(business).logo}</bdi>
                </span>
              ) : (
                <Globe size={22} aria-hidden="true" />
              )}
            </span>
            <span className={styles.siteFoot}>
              <span className={styles.siteName}>
                {name ? <bdi dir="auto">{name}</bdi> : <bdi dir="ltr">{guess.host}</bdi>}
                {industry ? (
                  <span className={styles.siteKind} data-testid="website-kind">
                    <bdi dir="auto">{industry}</bdi>
                  </span>
                ) : null}
              </span>
              {platform || languages ? (
                <span className={styles.chips} data-testid="website-found">
                  {platform ? (
                    <span className={styles.chip}>
                      <ShoppingBag size={12} aria-hidden="true" />
                      <bdi dir="auto">{platform}</bdi>
                    </span>
                  ) : null}
                  {languages ? (
                    <span className={styles.chip}>
                      <Languages size={12} aria-hidden="true" />
                      {languages}
                    </span>
                  ) : null}
                </span>
              ) : (
                <span className={styles.quiet}>{t('notReadYet')}</span>
              )}
            </span>
          </div>
          <span className={styles.actions}>
            {preview ? (
              <UnavailableAction
                label={t('yes')}
                tag={tn('preview.tag')}
                why={tn('preview.why')}
                testid="website-yes"
              />
            ) : (
              <button
                type="button"
                className={styles.primary}
                onClick={() => read(guess.host)}
                disabled={isStarting}
                data-testid="website-yes"
              >
                {isStarting ? t('starting') : t('yes')}
              </button>
            )}
            <button
              type="button"
              className={styles.secondary}
              onClick={() => setTyping(true)}
              data-testid="website-different"
            >
              {t('different')}
            </button>
          </span>
        </>
      ) : (
        <form
          className={styles.addressForm}
          onSubmit={(e) => {
            e.preventDefault();
            if (preview) return;
            if (typed) read(typed);
            else setRefused(true);
          }}
        >
          <input
            className={styles.addressField}
            value={address}
            onChange={(e) => {
              setAddress(e.target.value);
              setRefused(false);
            }}
            placeholder={t('placeholder')}
            aria-label={t('askTitle')}
            aria-invalid={refused}
            inputMode="url"
            dir="ltr"
            data-testid="website-address"
          />
          <span className={styles.actions}>
            {preview ? (
              <UnavailableAction
                label={t('readThis')}
                tag={tn('preview.tag')}
                why={tn('preview.why')}
                testid="website-read"
              />
            ) : (
              <button
                type="submit"
                className={styles.primary}
                disabled={isStarting || address.trim() === ''}
                data-testid="website-read"
              >
                {isStarting ? t('starting') : t('readThis')}
              </button>
            )}
            {guess ? (
              <button type="button" className={styles.secondary} onClick={() => setTyping(false)}>
                {t('back', { host: guess.host })}
              </button>
            ) : null}
          </span>
        </form>
      )}
      <p className={styles.consent} data-testid="website-consent">
        {t.rich('consent', {
          // The old app's pages, at the site root - outside this app's base path on purpose.
          terms: (chunks) => (
            <a href="/legal/terms-of-service" target="_blank" rel="noreferrer">
              {chunks}
            </a>
          ),
          privacy: (chunks) => (
            <a href="/legal/privacy-policy" target="_blank" rel="noreferrer">
              {chunks}
            </a>
          ),
        })}
      </p>
      {refused ? (
        <p className={styles.problem} role="alert" data-testid="website-refused">
          {t('notAnAddress')}
        </p>
      ) : null}

      <div className={styles.elsewhere} data-testid="website-elsewhere">
        <p className={styles.quiet}>{t('noWebsite')}</p>
        <span className={styles.sources}>
          {(
            [
              ['instagram', InstagramGlyph],
              ['catalogue', FileText],
              ['yourself', MessageCircle],
            ] as const
          ).map(([key, Icon]) => (
            // No route yet: a status with its tag, not a card to press (Omer, 2026-10-07).
            <UnavailableItem
              key={key}
              icon={<Icon size={15} />}
              title={t(`sources.${key}.title`)}
              tag={tn('notYet')}
              why={t(`sources.${key}.hint`)}
              testid={`website-source-${key}`}
            />
          ))}
        </span>
        <p className={styles.why}>{t('elsewhereWhy')}</p>
      </div>
    </div>
  );
}
