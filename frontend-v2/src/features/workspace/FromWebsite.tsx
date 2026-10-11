'use client';

import { useTranslations } from 'next-intl';
import { useId } from 'react';

import styles from './Workspace.module.css';

/**
 * 02's "From your website" chip, saying what it means.
 *
 * The sentence that explained it was the scan banner's on this screen; the
 * banner moved to Studio · Knowledge (cc2e8dc8) and took the explanation with
 * it, leaving the chips unexplained. So it is back, ON the chip: its title for
 * a pointer, and the same sentence as its accessible description - a hidden
 * node referenced by `aria-describedby` is still read as the description, and
 * is not read a second time as text.
 *
 * The words are the banner's own, unchanged (`workspace.intro` before
 * cc2e8dc8), in both languages.
 */
export function FromWebsite({
  domain,
  testId,
}: {
  /** The website it came from, as a host - or null when none is stored. */
  readonly domain: string | null;
  readonly testId?: string;
}) {
  const t = useTranslations('workspace');
  const id = useId();
  const why = domain ? t('provenance.why.withSite', { domain }) : t('provenance.why.noSite');
  return (
    <>
      <span className={styles.fromWebsite} title={why} aria-describedby={id} data-testid={testId}>
        {t('provenance.origin.scan')}
      </span>
      <span id={id} hidden>
        {why}
      </span>
    </>
  );
}
