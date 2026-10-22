'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { Link } from '@/i18n/navigation';
import { LOCALE_CODES } from '@/i18n/locales';
import drawer from '@/design-system/styles/drawer.module.css';

import { saveSystemLanguage } from './actions';
import styles from './Workspace.module.css';

/**
 * 11d: the SYSTEM language, and only that (Omer, 2026-10-12, W1) - the
 * language GOTCHA writes in for the business's own systems and team: the CRM,
 * Shopify, summaries and notes. `PUT /agents/settings/locale`.
 *
 * ★★ NOT THE CUSTOMERS' LANGUAGE. "Speaking to customers" is gone: GOTCHA
 *   answers every customer in the language they wrote in, a rule rather than
 *   a setting (Backend, 2026-10-12: the prompt rule, and the agent loop's pin
 *   fixed in bac9737e). The business's main language (`primaryLanguage`) is
 *   read only for knowledge written from the website, and the scan keeps it
 *   filled - so the card that edited it, and its switches that saved
 *   nothing, went with it.
 *
 * ★★ NOT THE INTERFACE LANGUAGE (Omer, 2026-10-11): it is personal, and lives
 *   in the person's own menu. This drawer only says where.
 */
export function LanguageDrawer({ systemLocale }: { readonly systemLocale: string | null }) {
  const t = useTranslations('workspace.languageDrawer');
  const tw = useTranslations('workspace');
  const locale = useLocale();
  const [system, setSystem] = useState(systemLocale ?? '');
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

  function save() {
    setProblem(null);
    setSaved(false);
    // Nothing chosen, or nothing changed: there is nothing to write.
    if (system === '' || system === (systemLocale ?? '')) return;
    startTransition(async () => {
      const written = await saveSystemLanguage(system);
      if (!written.ok) {
        setProblem(written.reason === 'forbidden' ? t('forbidden') : tw('failed'));
        return;
      }
      setSaved(true);
    });
  }

  return (
    <>
      <div className={drawer.drawerBody} data-testid="language-drawer">
        <div className={drawer.field}>
          <span className={drawer.fieldLabel}>{t('systemLabel')}</span>
          <select
            className={drawer.box}
            value={system}
            data-testid="language-system-select"
            onChange={(e) => setSystem(e.target.value)}
          >
            {system === '' ? <option value="">-</option> : null}
            {LOCALE_CODES.map((code) => (
              <option key={code} value={code}>
                {name(code)}
              </option>
            ))}
          </select>
          <span className={drawer.hint}>{t('systemHint')}</span>
        </div>
        <p className={drawer.hint} data-testid="language-customers-rule">
          {t('customersRule')}
        </p>
        <p className={drawer.hint} data-testid="language-mine-where">
          {t('mineWhere')}
        </p>
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
