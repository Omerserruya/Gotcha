import { getFormatter, getTranslations } from 'next-intl/server';

import { hasEverRun, type Automation } from '@/api/contracts/automations';
import { Link } from '@/i18n/navigation';
import styles from '@/features/studio/StudioSplit.module.css';

/**
 * 09's list column: the automation's name, what it does, and how often it
 * ran. ⚠ 02's line is "Ran 46 times this week"; `runCount` has no clock, so
 * the line is the all-time count - never captioned as a week - or that it is
 * switched off.
 */
export async function AutomationRail({
  automations,
  selectedId,
}: {
  readonly automations: readonly Automation[];
  readonly selectedId: string;
}) {
  const t = await getTranslations('automations');
  const format = await getFormatter();
  return (
    <>
      {automations.map((automation) => (
        <Link
          key={automation.id}
          href={{ pathname: '/studio/automations', query: { automation: automation.id } }}
          className={styles.row}
          data-dense=""
          aria-current={automation.id === selectedId ? 'page' : undefined}
          data-testid={`rail-${automation.id}`}
        >
          <span className={styles.rowTop}>
            <span
              className={styles.dot}
              data-tone={automation.isActive ? 'live' : undefined}
              aria-hidden="true"
            />
            <span className={styles.rowName}>{automation.name}</span>
          </span>
          {automation.description ? (
            <span className={styles.rowLine}>{automation.description}</span>
          ) : null}
          <span className={styles.rowState}>
            {!automation.isActive
              ? t('state.off')
              : hasEverRun(automation)
                ? t('rail.ran', {
                    count: automation.runCount,
                    n: format.number(automation.runCount),
                  })
                : t('rail.never')}
          </span>
        </Link>
      ))}
    </>
  );
}
