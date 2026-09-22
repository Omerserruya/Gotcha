import { getTranslations } from 'next-intl/server';

import { EmployeeList } from '@/features/employees/EmployeeList';
import styles from '@/features/employees/Employees.module.css';
import { loadEmployees } from '@/features/employees/load-employees';
import { PageContainer } from '@/shell/PageContainer';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * Studio · AI employees — screen 07.
 *
 * ── THE FOURTH VERB ──
 * The design says *"Hire, edit, pause, fire"*. `AIAgentStatus` is
 * `ACTIVE | DRAFT | PAUSED`, so **firing is not a state this platform has**.
 * The screen says so once, above the list — a missing verb in a stated list of
 * four reads as an oversight, and this one is a fact about the product.
 *
 * ── AND WHAT PAUSING ACTUALLY DOES ──
 * Nothing but stop replying. No handover, no reassignment, no notification —
 * so the confirmation names the people mid-conversation, with the number.
 *
 * ── WHAT IS ABSENT ──
 * **No escalation count.** `isHandedOver` has six-plus writers sharing only
 * *"a person ended up driving"*, and the cause would need
 * `ConversationHandover.reason`, which holds **zero rows while five
 * conversations carry the flag**. A cause column would be a confident zero for
 * every employee.
 *
 * **No knowledge-coverage-by-topic and no escalation-analysis suggestions** —
 * neither has a source.
 */
export default async function Page() {
  const t = await getTranslations('employees');
  const employees = await loadEmployees();

  if (employees === null) {
    return (
      <PageContainer title={t('title')} description={t('description')}>
        <p data-testid="employees-unavailable">{t('unavailable')}</p>
      </PageContainer>
    );
  }

  if (employees.length === 0) {
    return (
      <PageContainer title={t('title')} description={t('description')}>
        <div className={styles.empty} data-testid="employees-empty">
          <p className={styles.emptyLead}>{t('none')}</p>
          {/* The consequence, not just the absence. */}
          <p className={styles.emptyBody}>{t('noneBody')}</p>
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer title={t('title')} description={t('description')}>
      <div className={styles.screen} data-testid="employees-screen">
        {/*
          Stated once, above the list, because it is a fact about GOTCHA
          rather than about any one employee.
        */}
        <p className={styles.cannotFire} data-testid="cannot-fire">
          {t('cannotFire')}
        </p>

        <EmployeeList employees={employees} />
      </div>
    </PageContainer>
  );
}

export const generateMetadata = pageMetadata('primary.studio');
