import { getTranslations } from 'next-intl/server';

import { responsibilityOf } from '@/api/contracts/employees';
import { loadEmployees } from '@/features/employees/load-employees';
import { EmployeeSkills } from '@/features/skills/EmployeeSkills';
import styles from '@/features/skills/EmployeeSkills.module.css';
import { loadEmployeeSkillsTab } from '@/features/skills/load-skills';
import { avatarTone, employeeInitials } from '@/features/skills/skill-words';
import { channelMark } from '@/features/inbox/channel-marks';
import { Link } from '@/i18n/navigation';
import { PageContainer } from '@/shell/PageContainer';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * 07g - Studio · Employees · Edit an employee · Skills (design 6).
 *
 * ★ 07f's tabs, each to where that part is edited today: Profile and Limits
 *   and handover are the edit sheet's (07f is not rebuilt in this round),
 *   Knowledge and Channels are their own screens. Skills is this page.
 */
export default async function Page({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}) {
  const t = await getTranslations('skills.employee');
  const { id } = await params;
  const [employees, tab] = await Promise.all([loadEmployees(), loadEmployeeSkillsTab(id)]);
  const employee = employees?.find((e) => e.id === id) ?? null;

  if (!employee || !tab.assigned) {
    return (
      <PageContainer layout="screen" flush>
        <p className={styles.unread} role="status" data-testid="employee-skills-unread">
          {employees && !employee ? t('noEmployee') : t('unread')}
        </p>
      </PageContainer>
    );
  }

  const edit = { pathname: '/studio/employees', query: { employee: id, edit: '1' } } as const;

  return (
    <PageContainer layout="screen" flush>
      <EmployeeSkills
        employee={{ id, name: employee.name }}
        assigned={tab.assigned}
        candidates={tab.candidates}
        situations={tab.situations}
        head={
          <span className={styles.identity}>
            <span className={styles.bigAvatar} data-tone={avatarTone(id)} aria-hidden="true">
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
                {responsibilityOf(employee) ? (
                  <span className={styles.lineText} title={responsibilityOf(employee) ?? undefined}>
                    {responsibilityOf(employee)}
                  </span>
                ) : null}
                {employee.channels.length > 0 ? (
                  <span className={styles.channelIcons} aria-label={t('channelsLabel')}>
                    {employee.channels.map((c) => {
                      const { Icon } = channelMark(c.toUpperCase());
                      return (
                        <span key={c} title={c}>
                          <Icon size={13} strokeWidth={2} />
                        </span>
                      );
                    })}
                  </span>
                ) : null}
              </span>
            </span>
          </span>
        }
        tabs={
          <nav className={styles.tabs} aria-label={t('tabsLabel')}>
            <Link href={edit} className={styles.tabLink} scroll={false}>
              {t('tabs.profile')}
            </Link>
            <Link href="/studio/knowledge" className={styles.tabLink}>
              {t('tabs.knowledge')}
            </Link>
            <span className={styles.tabLink} aria-current="page" data-testid="employee-tab-skills">
              {t('tabs.skills', { count: tab.assigned.skills.length })}
            </span>
            <Link href="/settings/channels" className={styles.tabLink}>
              {t('tabs.channels')}
            </Link>
            <Link href={edit} className={styles.tabLink} scroll={false}>
              {t('tabs.limits')}
            </Link>
          </nav>
        }
      />
    </PageContainer>
  );
}

export const generateMetadata = pageMetadata('studio.employees');
