import { getTranslations } from 'next-intl/server';

import { EmployeeHead, EmployeeTabs } from '@/features/employees/page/EmployeeFrame';
import { loadEmployeePage } from '@/features/employees/page/load-employee-page';
import { EmployeeSkills } from '@/features/skills/EmployeeSkills';
import styles from '@/features/skills/EmployeeSkills.module.css';
import { loadEmployeeSkillsTab } from '@/features/skills/load-skills';
import { PageContainer } from '@/shell/PageContainer';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * 07g - Studio · Employees · an employee · Skills (design 6). One of the
 * employee page's four tabs; every other tab is its own page beside it, and
 * none opens a sheet (Omer, 2026-10-13, E2).
 */
export default async function Page({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}) {
  const t = await getTranslations('skills.employee');
  const { id } = await params;
  // The count is this tab's own list, so the frame's read of it is skipped.
  const [read, tab] = await Promise.all([
    loadEmployeePage(id, { withSkills: false }),
    loadEmployeeSkillsTab(id),
  ]);
  const { employee } = read;

  if (!employee || !tab.assigned) {
    return (
      <PageContainer layout="screen" flush>
        <p className={styles.unread} role="status" data-testid="employee-skills-unread">
          {read.missing ? t('noEmployee') : t('unread')}
        </p>
      </PageContainer>
    );
  }

  return (
    <PageContainer layout="screen" flush>
      <EmployeeSkills
        employee={{ id, name: employee.name }}
        assigned={tab.assigned}
        candidates={tab.candidates}
        situations={tab.situations}
        head={<EmployeeHead employee={employee} />}
        tabs={<EmployeeTabs id={id} current="skills" skillsCount={tab.assigned.skills.length} />}
      />
    </PageContainer>
  );
}

export const generateMetadata = pageMetadata('studio.employees');
