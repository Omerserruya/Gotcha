import { getTranslations } from 'next-intl/server';

import { responsibilityOf, type Employee } from '@/api/contracts/employees';
import styles from '@/features/skills/EmployeeSkills.module.css';
import { avatarTone, employeeInitials } from '@/features/skills/skill-words';
import { Link } from '@/i18n/navigation';

/**
 * The employee's page (07f/07g, design 6): one page, four tabs, every edit
 * on it (Omer, 2026-10-13, E2). "Edit" on 07 opens the Profile tab.
 *
 *   Profile     every regular setting, top to bottom, Limits and the
 *               handoff to a person inside it
 *   Knowledge   what it reads, and which knowledge is connected to it
 *   Skills      what it knows how to do
 *   Channels    where it answers - 07g's tab, the playbook's to decide
 *
 * There is no Limits tab: 07g's "Limits and handover" is the Profile's.
 */
export const EMPLOYEE_TABS = ['profile', 'knowledge', 'skills', 'channels'] as const;
export type EmployeeTab = (typeof EMPLOYEE_TABS)[number];

/** Each tab's address. */
export function employeeTabHref(id: string, tab: EmployeeTab): string {
  return tab === 'profile' ? `/studio/employees/${id}` : `/studio/employees/${id}/${tab}`;
}

/** The head: avatar, name, standing and the line under it. */
export async function EmployeeHead({ employee }: { readonly employee: Employee }) {
  const t = await getTranslations('skills.employee');
  const line = responsibilityOf(employee);
  return (
    <span className={styles.identity}>
      <span className={styles.bigAvatar} data-tone={avatarTone(employee.id)} aria-hidden="true">
        {employeeInitials(employee.name)}
      </span>
      <span className={styles.identityText}>
        <span className={styles.nameRow}>
          <h1 className={styles.employeeName}>{employee.name}</h1>
          <span className={styles.status} data-status={employee.status}>
            {t(
              `status.${employee.status === 'ACTIVE' ? 'live' : employee.status === 'PAUSED' ? 'paused' : 'draft'}`,
            )}
          </span>
        </span>
        <span className={styles.line}>
          {line ? (
            <span className={styles.lineText} title={line}>
              <bdi dir="auto">{line}</bdi>
            </span>
          ) : null}
        </span>
      </span>
    </span>
  );
}

/** The four tabs; the current one is not a link. */
export async function EmployeeTabs({
  id,
  current,
  skillsCount,
}: {
  readonly id: string;
  readonly current: EmployeeTab;
  /** `null`: unread - the label goes without its count. */
  readonly skillsCount: number | null;
}) {
  const t = await getTranslations('skills.employee');
  const label = (tab: EmployeeTab) =>
    tab === 'skills'
      ? skillsCount === null
        ? t('tabs.skillsUnread')
        : t('tabs.skills', { count: skillsCount })
      : t(`tabs.${tab}`);
  return (
    <nav className={styles.tabs} aria-label={t('tabsLabel')} data-testid="employee-tabs">
      {EMPLOYEE_TABS.map((tab) =>
        tab === current ? (
          <span
            key={tab}
            className={styles.tabLink}
            aria-current="page"
            data-testid={`employee-tab-${tab}`}
          >
            {label(tab)}
          </span>
        ) : (
          <Link
            key={tab}
            href={employeeTabHref(id, tab)}
            className={styles.tabLink}
            data-testid={`employee-tab-${tab}`}
          >
            {label(tab)}
          </Link>
        ),
      )}
    </nav>
  );
}
