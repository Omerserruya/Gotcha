import { useTranslations } from 'next-intl';

import { Link } from '@/i18n/navigation';

import type { SlaSetup } from './load-sla-setup';
import styles from './Workspace.module.css';

/**
 * The response target's row on Settings · Workspace (W2). Its Edit opens the
 * drawer (`?panel=sla`) - for an Owner only: anyone else's read is a 403, and
 * the row says whose it is instead of offering an Edit that could not save.
 */
export function SlaRow({ setup }: { readonly setup: SlaSetup }) {
  const t = useTranslations('workspace');
  const value =
    setup.kind === 'forbidden'
      ? t('sla.ownerOnly')
      : setup.kind === 'failed'
        ? t('sla.unavailable')
        : !setup.settings.enabled || setup.settings.slaMinutes === null
          ? t('sla.off')
          : setup.settings.warningThreshold === null
            ? t('sla.onNoWarning', { minutes: setup.settings.slaMinutes })
            : t('sla.on', {
                minutes: setup.settings.slaMinutes,
                warning: setup.settings.warningThreshold,
              });
  const quiet = setup.kind !== 'owner' || !setup.settings.enabled;
  return (
    <div className={styles.row} data-testid="fact-sla">
      <div className={styles.label}>{t('fact.sla')}</div>
      <div
        className={[styles.value, quiet ? styles.unset : ''].join(' ').trim()}
        data-testid="fact-value-sla"
      >
        {value}
      </div>
      {setup.kind === 'owner' ? (
        <Link
          href={{ pathname: '/settings/workspace', query: { panel: 'sla' } }}
          className={styles.edit}
          data-testid="fact-edit-sla"
          scroll={false}
        >
          {t('edit')}
        </Link>
      ) : null}
    </div>
  );
}
