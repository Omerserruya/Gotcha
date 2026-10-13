import { getTranslations } from 'next-intl/server';

import { loadCapabilities } from '@/features/capabilities/load-capabilities';
import { loadIntegrationAccess } from '@/features/employees/load-employees';
import { EmployeeHead, EmployeeTabs } from '@/features/employees/page/EmployeeFrame';
import { EmployeeProfile } from '@/features/employees/page/EmployeeProfile';
import styles from '@/features/employees/page/EmployeePage.module.css';
import { loadEmployeePage } from '@/features/employees/page/load-employee-page';
import { loadEmployeeTools } from '@/features/employees/page/load-employee-tools';
import { toolLevelRows } from '@/features/employees/page/tool-label';
import { PageContainer } from '@/shell/PageContainer';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * Studio · Employees · an employee · Profile - where "Edit" on 07 leads
 * (Omer, 2026-10-13, E2). Every regular setting, one list, one Save.
 */
export default async function Page({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}) {
  const t = await getTranslations('employees.page');
  const tc = await getTranslations('capabilities');
  const { id } = await params;
  const [read, access, { integrations }, tools] = await Promise.all([
    loadEmployeePage(id),
    loadIntegrationAccess(id),
    // The integrations' names, for "{integration} · {action}".
    loadCapabilities(),
    loadEmployeeTools(id),
  ]);
  const { employee } = read;

  if (!employee) {
    return (
      <PageContainer layout="screen" flush>
        <p className={styles.unread} role="status" data-testid="employee-page-unread">
          {read.missing ? t('missing') : t('unread')}
        </p>
      </PageContainer>
    );
  }

  /* E5: this employee's own levels, each action named (tool-label.ts). */
  const levels = toolLevelRows(
    tools,
    (slug) => integrations?.find((integration) => integration.slug === slug)?.name ?? null,
    (toolName) => tc(`tool.${toolName}` as 'tool.send_message'),
  );

  return (
    <PageContainer layout="screen" flush>
      <EmployeeProfile
        employee={employee}
        access={access}
        levels={levels}
        head={<EmployeeHead employee={employee} />}
        tabs={<EmployeeTabs id={id} current="profile" skillsCount={read.skillsCount} />}
      />
    </PageContainer>
  );
}

export const generateMetadata = pageMetadata('studio.employees');
