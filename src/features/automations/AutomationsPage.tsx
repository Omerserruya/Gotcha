import { getTranslations } from 'next-intl/server';

import { AutomationsList } from './AutomationsList';
import styles from './Automations.module.css';
import { loadAutomations, loadCatalog } from './load-automations';
import { NewAutomation } from './NewAutomation';
import type { Template } from './templates';

/**
 * 09c's data: the list - or no access, unread, none - and, with the sheet
 * open, the first step's catalogue. Without access nothing is offered.
 */
export async function ListSection({
  creating,
  fromTemplate,
}: {
  readonly creating: boolean;
  readonly fromTemplate: Template | null;
}) {
  const t = await getTranslations('automations');
  const [automations, catalog] = await Promise.all([
    loadAutomations(),
    creating ? loadCatalog() : Promise.resolve(null),
  ]);
  return (
    <>
      {automations === 'forbidden' ? (
        <div className={styles.empty} data-testid="automations-forbidden">
          <p className={styles.emptyLead}>{t('forbidden.title')}</p>
          <p className={styles.quiet}>{t('forbidden.lead')}</p>
        </div>
      ) : automations === null ? (
        <p className={styles.quiet} role="status" data-testid="automations-unread">
          {t('unavailable')}
        </p>
      ) : automations.length === 0 ? (
        <div className={styles.empty} data-testid="automations-empty">
          <p className={styles.emptyLead}>{t('none')}</p>
          <p className={styles.quiet}>{t('noneBody')}</p>
        </div>
      ) : (
        <AutomationsList automations={automations} />
      )}
      {automations === 'forbidden' ? null : fromTemplate ? (
        <NewAutomation catalog={null} template={fromTemplate} />
      ) : creating ? (
        <NewAutomation catalog={catalog} />
      ) : null}
    </>
  );
}
