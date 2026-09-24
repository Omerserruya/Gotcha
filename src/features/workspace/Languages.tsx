import { getLocale, getTranslations } from 'next-intl/server';

import {
  namedLanguages,
  sharesAreMeaningful,
  undetected,
  unstoredLanguages,
  type LanguageShare,
} from '@/api/contracts/language-share';

import styles from './Workspace.module.css';

/**
 * Languages — screen 11d.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THREE SETTINGS, AND THE DESIGN IS RIGHT TO SEPARATE THEM
 * ════════════════════════════════════════════════════════════════════════════
 *   what customers are answered in   decided per conversation · NOT a setting
 *   what GOTCHA writes in            `Tenant.defaultLocale` · workspace-wide
 *   what THIS person sees            `User.locale` · theirs alone
 *
 * Only the last two are stored, and they are stored in different places. The
 * first is not a setting at all: the reply language is decided from the
 * customer's own message, on a prompt rule marked non-negotiable, and the
 * stored `primaryLanguage` is never read for it.
 *
 * So the customer-facing half is a STATEMENT here, not a control — and the
 * statement is reassuring rather than apologetic, because the behaviour is
 * already right. What the panel adds is the thing a merchant cannot see from
 * inside a conversation: which languages are arriving.
 */
export async function Languages({
  share,
  systemLocale,
  myLocale,
  storedLanguage,
}: {
  readonly share: LanguageShare | null;
  readonly systemLocale: string | null;
  readonly myLocale: string | null;
  /** `BusinessProfile.primaryLanguage`, for the unstored-language comparison. */
  readonly storedLanguage: string | null;
}) {
  const t = await getTranslations('workspace.languages');
  const locale = await getLocale();
  const names = new Intl.DisplayNames([locale], { type: 'language' });
  const name = (code: string) => {
    try {
      return names.of(code) ?? code;
    } catch {
      return code;
    }
  };

  return (
    <section className={styles.languages} data-testid="languages">
      <h2 className={styles.provenanceHeading}>{t('heading')}</h2>

      {/*
        First, because it is the answer to the question the rest of the panel
        would otherwise raise. A merchant who reads "12 conversations in
        English" before this sentence spends the next paragraph worrying.
      */}
      <p className={styles.provenanceLead} data-testid="languages-replies">
        {t('replies')}
      </p>

      {share === null ? (
        <p className={styles.unavailable} data-testid="languages-unavailable">
          {t('unavailable')}
        </p>
      ) : share.total === 0 ? (
        <p className={styles.provenanceLead} data-testid="languages-none">
          {t('none', { days: share.windowDays })}
        </p>
      ) : (
        <div data-testid="languages-mix">
          <p className={styles.provenanceLead}>
            {t('window', { days: share.windowDays, total: share.total })}
          </p>

          <ul className={styles.languageRows}>
            {namedLanguages(share).map((row) => (
              <li key={row.locale} className={styles.languageRow} data-testid="language-row">
                {/*
                  Shares only when there are enough conversations for a
                  percentage to survive one more chat. Same reasoning as the
                  credits estimate: a rate needs a sample, and a number that
                  looks authoritative and is not is worse than a count.
                */}
                {sharesAreMeaningful(share)
                  ? t('rowWithShare', {
                      language: name(row.locale!),
                      count: row.conversations,
                      share: row.share,
                    })
                  : t('row', { language: name(row.locale!), count: row.conversations })}
              </li>
            ))}
          </ul>

          {!sharesAreMeaningful(share) ? (
            <p className={styles.provenanceBasis} data-testid="languages-thin">
              {t('thinSample')}
            </p>
          ) : null}

          {/*
            Kept, and kept OUT of the language list. It is a row of the same
            total — dropping it silently would leave percentages that do not
            add up — but it is not a language and must not be named as one.
          */}
          {undetected(share) ? (
            <p className={styles.provenanceBasis} data-testid="languages-undetected">
              {t('undetected', { count: undetected(share)!.conversations })}
            </p>
          ) : null}

          {/*
            The design's Russian line, on real data. Framed as information
            rather than a problem: replies went out correctly regardless, and
            what this tells a merchant is which markets are writing to them.
          */}
          {unstoredLanguages(share, storedLanguage).length > 0 ? (
            <p className={styles.provenanceLead} data-testid="languages-unstored">
              {t('unstored', {
                languages: unstoredLanguages(share, storedLanguage)
                  .map((r) => name(r.locale!))
                  .join(', '),
              })}
            </p>
          ) : null}
        </div>
      )}

      <p className={styles.provenanceHeading}>{t('systemHeading')}</p>
      <p className={styles.provenanceLead} data-testid="languages-system">
        {systemLocale ? t('system', { locale: name(systemLocale) }) : t('systemUnknown')}
      </p>
      <p className={styles.provenanceBasis} data-testid="languages-mine">
        {/*
          A different setting from the one above it, and the design is right
          that they are separate: one is what GOTCHA writes, the other is what
          this person reads. Changing yours changes nothing for anybody else.
        */}
        {myLocale ? t('mine', { locale: name(myLocale) }) : t('mineUnset')}
      </p>

      {/*
        Named rather than drawn. `PATCH /workspace` refuses a list longer than
        one with a 422 — so there is no silent loss to protect against any
        more, but there is still nowhere to put a second language.
      */}
      <p className={styles.provenanceBasis} data-testid="languages-not-storable">
        {t('notStorable')}
      </p>
    </section>
  );
}
