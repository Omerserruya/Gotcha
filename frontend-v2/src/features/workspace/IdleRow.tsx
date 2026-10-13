import { useTranslations } from 'next-intl';

import { Link } from '@/i18n/navigation';
import { wholeUnit } from '@/lib/duration';

import type { IdleSetup } from './load-idle';
import styles from './Workspace.module.css';

type Translate = ReturnType<typeof useTranslations<'workspace'>>;

/** "3 hours", "a day" - a delay in its largest whole unit. */
export function delayWords(minutes: number, t: Translate): string {
  const { unit, count } = wholeUnit(minutes * 60_000);
  return t(`idle.duration.${unit}`, { count });
}

/**
 * Follow-up and auto-close on Settings · Workspace (S3). Its Edit opens the
 * drawer (`?panel=idle`) for an Owner; anyone else's read is a 403, and the
 * row says whose it is with no Edit that could not save.
 */
export function IdleRow({ setup }: { readonly setup: IdleSetup }) {
  const t = useTranslations('workspace');
  let value: string;
  let quiet = true;
  if (setup.kind === 'forbidden') value = t('idle.ownerOnly');
  else if (setup.kind === 'failed') value = t('idle.unavailable');
  else {
    const s = setup.settings;
    const parts = [
      s.reminderEnabled && s.reminderDelayMinutes !== null
        ? t('idle.reminderAfter', { delay: delayWords(s.reminderDelayMinutes, t) })
        : null,
      s.autoCloseEnabled && s.autoCloseDelayMinutes !== null
        ? t('idle.closeAfter', { delay: delayWords(s.autoCloseDelayMinutes, t) })
        : null,
    ].filter((part): part is string => part !== null);
    quiet = parts.length === 0;
    value = parts.length === 0 ? t('idle.off') : parts.join(' · ');
  }
  return (
    <div className={styles.row} data-testid="fact-idle">
      <div className={styles.label}>{t('fact.idle')}</div>
      <div
        className={[styles.value, quiet ? styles.unset : ''].join(' ').trim()}
        data-testid="fact-value-idle"
      >
        {value}
      </div>
      {setup.kind === 'owner' ? (
        <Link
          href={{ pathname: '/settings/workspace', query: { panel: 'idle' } }}
          className={styles.edit}
          data-testid="fact-edit-idle"
          scroll={false}
        >
          {t('edit')}
        </Link>
      ) : null}
    </div>
  );
}
