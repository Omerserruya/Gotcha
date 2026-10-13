import { getTranslations } from 'next-intl/server';

import { capabilityStance, hasOwnWords, humaniseToolName } from '@/api/contracts/capabilities';
import { loadCapabilities } from '@/features/capabilities/load-capabilities';
import { loadIntegrationAccess } from '@/features/employees/load-employees';
import { EmployeeHead, EmployeeTabs } from '@/features/employees/page/EmployeeFrame';
import { EmployeeProfile } from '@/features/employees/page/EmployeeProfile';
import styles from '@/features/employees/page/EmployeePage.module.css';
import { loadEmployeePage } from '@/features/employees/page/load-employee-page';
import { readTools } from '@/features/skills/skill-actions';
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
  const [read, access, { capabilities }, toolWords] = await Promise.all([
    loadEmployeePage(id),
    loadIntegrationAccess(id),
    loadCapabilities(),
    // Each action's provider and words ("WooCommerce · Get customer"), as Skills reads them.
    readTools(),
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

  const wordsOf = (toolName: string) => toolWords?.find((tool) => tool.name === toolName) ?? null;
  /** "WooCommerce · Get customer"; our own words or the name made readable when the catalogue is silent. */
  const actionLabel = (toolName: string) =>
    wordsOf(toolName)?.actionLabel ??
    (hasOwnWords(toolName)
      ? tc(`tool.${toolName}` as 'tool.send_message')
      : humaniseToolName(toolName));

  return (
    <PageContainer layout="screen" flush>
      <EmployeeProfile
        employee={employee}
        access={access}
        mayDo={
          capabilities
            ? capabilities
                .filter((c) => c.kind === 'action')
                .map((c) => {
                  const provider = wordsOf(c.toolName)?.providerLabel;
                  return {
                    toolName: c.toolName,
                    label: provider
                      ? `${provider} · ${actionLabel(c.toolName)}`
                      : actionLabel(c.toolName),
                    stance: capabilityStance(c),
                  };
                })
            : null
        }
        head={<EmployeeHead employee={employee} />}
        tabs={<EmployeeTabs id={id} current="profile" skillsCount={read.skillsCount} />}
      />
    </PageContainer>
  );
}

export const generateMetadata = pageMetadata('studio.employees');
