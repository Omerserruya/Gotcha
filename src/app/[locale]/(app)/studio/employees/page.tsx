import { getTranslations } from 'next-intl/server';

import { loadCapabilities } from '@/features/capabilities/load-capabilities';
import { EmployeeDetail } from '@/features/employees/EmployeeDetail';
import { EmployeeRail } from '@/features/employees/EmployeeRail';
import styles from '@/features/employees/Employees.module.css';
import { loadEmployees } from '@/features/employees/load-employees';
import { StudioSplit } from '@/features/studio/StudioSplit';
import { PageContainer } from '@/shell/PageContainer';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * Studio · AI employees — screen 07.
 *
 * ── THE FOURTH VERB, AND WHY THE SENTENCE GREW ──
 * The design says *"Hire, edit, pause, fire"*. `AIAgentStatus` is
 * `ACTIVE | DRAFT | PAUSED`, so **firing is not a state this platform has**.
 *
 * The note above the list used to say only that. Then Delete was added, and
 * *"there is no way to retire one"* ended up sitting **directly above the most
 * destructive control on the screen** — so a reader denied the thing they
 * wanted would reach for the nearest thing to it. **Delete is not retirement:
 * retiring would keep the record and stop the work; delete destroys the
 * employee and leaves live conversations waiting for a person.**
 *
 * The sentence was still true and no longer sufficient. It now distinguishes
 * all three — pause keeps it, delete removes it, neither retires it — because
 * **what someone concludes before opening the dialog is the part the dialog
 * cannot fix.**
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
export default async function Page({
  searchParams,
}: {
  readonly searchParams?: Promise<{ readonly employee?: string }>;
} = {}) {
  const t = await getTranslations('employees');
  // The detail's permissions and connected tools are the business's, read once.
  const [employees, { capabilities, integrations }] = await Promise.all([
    loadEmployees(),
    loadCapabilities(),
  ]);
  const wanted = (await searchParams)?.employee;
  const selected = employees?.find((e) => e.id === wanted) ?? employees?.[0] ?? null;

  /*
    07, measured: 02's screen header — the title, a line that counts them,
    and "Hire an employee" on the right — over a split: the list (330) and
    the selected employee (888), each scrolling inside itself.
  */
  const summary = employees?.length
    ? t('summary', {
        working: employees.filter((e) => e.status === 'ACTIVE').length,
        paused: employees.filter((e) => e.status === 'PAUSED').length,
      })
    : t('description');

  return (
    <PageContainer
      layout="screen"
      headerPadEnd={22}
      flush
      title={t('title')}
      description={summary}
      actions={
        // 07b–07d (hiring) are not built yet: drawn, and it says so.
        <span
          className={styles.hire}
          aria-disabled="true"
          title={t('hireNotYet')}
          data-testid="hire"
        >
          {t('hire')}
        </span>
      }
    >
      <StudioSplit
        label={t('rail.label')}
        list={
          employees && selected ? (
            <EmployeeRail employees={employees} selectedId={selected.id} />
          ) : null
        }
        detail={
          employees === null ? (
            <p data-testid="employees-unavailable">{t('unavailable')}</p>
          ) : selected === null ? (
            <div className={styles.empty} data-testid="employees-empty">
              <p className={styles.emptyLead}>{t('none')}</p>
              {/* The consequence, not just the absence. */}
              <p className={styles.emptyBody}>{t('noneBody')}</p>
            </div>
          ) : (
            <EmployeeDetail
              employee={selected}
              capabilities={capabilities}
              integrations={integrations}
            />
          )
        }
      />
    </PageContainer>
  );
}

export const generateMetadata = pageMetadata('primary.studio');
