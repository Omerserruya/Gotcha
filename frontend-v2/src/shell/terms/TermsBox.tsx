'use client';

import { useLocale, useTranslations } from 'next-intl';
import type { RefObject } from 'react';

import { legalUrls } from '@/lib/legal';

import styles from './TermsBox.module.css';

/**
 * The Terms of Service and Privacy Policy box - ONE box for every screen that
 * records an acceptance: the setup link (ResetPanel) and the Terms before
 * first entry with Google (TermsGate). Lifted out of ResetPanel on 2026-11-22
 * so the two can never show different words.
 *
 * ★ The words matter beyond the screen: both acceptances send the label AS
 *   RENDERED (`capturedText`), so `labelRef` points at the exact text the
 *   person saw - read it with `textContent`, never rebuild it.
 * ★ The same rows are written on the server for both, with a different
 *   source (Backend, ff3a1b9f), which is why the box must be the same too.
 */
export function TermsBox({
  checked,
  onChange,
  disabled,
  labelRef,
  testIdPrefix,
}: {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly disabled?: boolean;
  readonly labelRef: RefObject<HTMLSpanElement | null>;
  /** `reset` on the setup link, `terms` on the gate: `<prefix>-terms-box`, … */
  readonly testIdPrefix: string;
}) {
  const t = useTranslations('auth.recover.reset');
  const locale = useLocale() === 'he' ? 'he' : 'en';
  return (
    <label className={styles.terms} data-testid={`${testIdPrefix}-terms`}>
      <input
        type="checkbox"
        className={styles.termsBox}
        checked={checked}
        required
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        data-testid={`${testIdPrefix}-terms-box`}
      />
      <span ref={labelRef}>
        {t.rich('terms', {
          terms: (chunks) => (
            <a
              href={legalUrls(locale).terms}
              target="_blank"
              rel="noreferrer"
              data-testid={`${testIdPrefix}-terms-link`}
            >
              {chunks}
            </a>
          ),
          privacy: (chunks) => (
            <a
              href={legalUrls(locale).privacy}
              target="_blank"
              rel="noreferrer"
              data-testid={`${testIdPrefix}-privacy-link`}
            >
              {chunks}
            </a>
          ),
        })}
      </span>
    </label>
  );
}
