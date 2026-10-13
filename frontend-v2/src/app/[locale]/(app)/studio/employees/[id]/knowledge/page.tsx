import { getTranslations } from 'next-intl/server';

import { EmployeeHead, EmployeeTabs } from '@/features/employees/page/EmployeeFrame';
import { EmployeeKnowledge } from '@/features/employees/page/EmployeeKnowledge';
import styles from '@/features/employees/page/EmployeePage.module.css';
import { loadEmployeeKnowledge } from '@/features/employees/page/load-employee-knowledge';
import { loadEmployeePage } from '@/features/employees/page/load-employee-page';
import { PageContainer } from '@/shell/PageContainer';
import { pageMetadata } from '@/shell/page-metadata';

/** Studio · Employees · an employee · Knowledge: what it reads, and what is connected to it. */
export default async function Page({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}) {
  const t = await getTranslations('employees.page');
  const { id } = await params;
  const [read, sources] = await Promise.all([loadEmployeePage(id), loadEmployeeKnowledge()]);
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

  return (
    <PageContainer layout="screen" flush>
      <EmployeeKnowledge
        employee={{ id, name: employee.name, departmentId: employee.departmentId }}
        connected={employee.knowledgeSources}
        sources={sources}
        head={<EmployeeHead employee={employee} />}
        tabs={<EmployeeTabs id={id} current="knowledge" skillsCount={read.skillsCount} />}
      />
    </PageContainer>
  );
}

export const generateMetadata = pageMetadata('studio.employees');
