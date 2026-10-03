'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import {
  namedLanguages,
  sharesAreMeaningful,
  type LanguageShare,
} from '@/api/contracts/language-share';
import { Link } from '@/i18n/navigation';
import drawer from '@/design-system/styles/drawer.module.css';

import { saveWorkspaceFacts } from './actions';
import styles from './Workspace.module.css';

/** Offered for the main language; the stored one is added when it is not here. */
const COMMON = ['he', 'en', 'ar', 'ru', 'fr', 'es', 'de'] as const;

/**
 * 11d, measured: two cards — "Speaking to customers" and "Inside GOTCHA —
 * system language" — and no paragraphs.
 *
 * What is stored, and so what is live: the business's MAIN language
 * (`primaryLanguage`, the language knowledge from the website is written
 * in), one entry, through `PATCH /workspace`. Replies follow each
 * customer's own language on a rule that is not a setting, so that switch
 * is drawn on and not live; "Any other language", the translate switch and
 * the system language have no store here — drawn, not live, each with why.
 * "Also answers in" is what the last 30 days actually saw.
 */
export function LanguageDrawer({
  storedLanguage,
  share,
  systemLocale,
  myLocale,
  updatedAt,
}: {
  readonly storedLanguage: string | null;
  readonly share: LanguageShare | null;
  readonly systemLocale: string | null;
  readonly myLocale: string | null;
  readonly updatedAt: string | null;
}) {
  const t = useTranslations('workspace.languageDrawer');
  const tw = useTranslations('workspace');
  const locale = useLocale();
  const [main, setMain] = useState(storedLanguage ?? '');
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [isPending, startTransition] = useTransition();

  const name = (code: string): string => {
    try {
      return new Intl.DisplayNames([locale], { type: 'language' }).of(code) ?? code;
    } catch {
      return code;
    }
  };

  const options = [...new Set([...(storedLanguage ? [storedLanguage] : []), ...COMMON])];
  const seen = share ? namedLanguages(share).filter((r) => r.locale !== main) : [];
  const top = seen[0] ?? null;

  function save() {
    setProblem(null);
    setSaved(false);
    startTransition(async () => {
      const result = await saveWorkspaceFacts({ languages: main ? [main] : [] }, updatedAt);
      if (result.ok) setSaved(true);
      else setProblem(result.reason === 'stale' ? tw('stale') : tw('failed'));
    });
  }

  return (
    <>
      <div className={drawer.drawerBody} data-testid="language-drawer">
        <section className={styles.langCard} data-testid="language-customers">
          <h3 className={drawer.sectionTitle}>{t('customers')}</h3>
          <div className={drawer.pair}>
            <label className={drawer.field}>
              <span className={drawer.fieldLabel}>{t('main')}</span>
              <select
                className={drawer.box}
                value={main}
                title={t('mainHint')}
                data-testid="language-main"
                onChange={(e) => setMain(e.target.value)}
              >
                {main === '' ? <option value="">—</option> : null}
                {options.map((code) => (
                  <option key={code} value={code}>
                    {name(code)}
                  </option>
                ))}
              </select>
            </label>
            <div className={drawer.field}>
              <span className={drawer.fieldLabel}>{t('also')}</span>
              <span className={styles.langChips} data-testid="language-also">
                {share === null ? (
                  <span className={styles.langNone}>—</span>
                ) : (
                  seen.map((r) => (
                    <span key={r.locale} className={styles.langChip}>
                      {name(r.locale!)}
                    </span>
                  ))
                )}
                <span className={styles.langAdd} aria-disabled="true" title={t('alsoHint')}>
                  {t('add')}
                </span>
              </span>
            </div>
          </div>

          <p className={styles.langSwitchRow} title={t('repliesHint')}>
            <span className={styles.weekPill} data-on="yes" aria-hidden="true" />
            {t('replies')}
          </p>

          <div className={styles.langOther}>
            <span className={styles.langOtherLabel}>{t('other')}</span>
            <span
              className={styles.langSegmented}
              aria-disabled="true"
              title={t('otherHint')}
              data-testid="language-other"
            >
              <span className={styles.langSegment}>
                {t('otherMain', { language: main ? name(main) : '—' })}
              </span>
              <span className={styles.langSegment}>{t('otherTheirs')}</span>
              <span className={styles.langSegment}>{t('otherPerson')}</span>
            </span>
          </div>

          {top && share ? (
            <p className={styles.langHint} data-testid="language-hint">
              {sharesAreMeaningful(share)
                ? t('hintShare', {
                    share: top.share,
                    days: share.windowDays,
                    language: name(top.locale!),
                  })
                : t('hintCount', {
                    count: top.conversations,
                    total: share.total,
                    days: share.windowDays,
                    language: name(top.locale!),
                  })}
            </p>
          ) : null}
        </section>

        <section className={styles.langCard} data-testid="language-system">
          <h3 className={drawer.sectionTitle}>{t('system')}</h3>
          <div className={drawer.field}>
            <span className={drawer.fieldLabel}>{t('systemLabel')}</span>
            <span className={drawer.box} aria-disabled="true" title={t('systemHint')}>
              {systemLocale ? name(systemLocale) : '—'}
            </span>
          </div>
          <p className={styles.langSwitchRow} title={t('translateHint')}>
            <span className={styles.weekPill} data-on="no" aria-hidden="true" />
            {t('translate', { language: systemLocale ? name(systemLocale) : '—' })}
          </p>
          <p className={drawer.hint} data-testid="language-mine">
            {myLocale ? t('mine', { language: name(myLocale) }) : t('mineUnknown')}
          </p>
        </section>
      </div>
      <footer className={drawer.drawerFoot}>
        <button
          type="button"
          className={styles.saveButton}
          data-testid="drawer-save-language"
          disabled={isPending}
          onClick={save}
        >
          {isPending ? tw('saving') : tw('save')}
        </button>
        <Link href="/settings/workspace" className={drawer.drawerCancel}>
          {tw('cancel')}
        </Link>
        {problem ? (
          <span className={styles.rowNote}>{problem}</span>
        ) : saved ? (
          <span className={styles.rowNoteQuiet} data-testid="language-saved">
            {tw('saved')}
          </span>
        ) : null}
      </footer>
    </>
  );
}
