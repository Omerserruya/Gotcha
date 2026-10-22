import { getTranslations } from 'next-intl/server';

import { channelName } from '@/api/contracts/inbox';
import { loadReachability } from '@/features/employees/load-employees';
import { foldWidget } from '@/features/employees/reach';
import { automationsLink, WhoAnswers } from '@/features/employees/WhoAnswers';
import { EmployeeHead, EmployeeTabs } from '@/features/employees/page/EmployeeFrame';
import styles from '@/features/employees/page/EmployeePage.module.css';
import { loadEmployeePage } from '@/features/employees/page/load-employee-page';
import tab from '@/features/skills/EmployeeSkills.module.css';
import { PageContainer } from '@/shell/PageContainer';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * Studio · Employees · an employee · Channels - 07g's fourth tab: where it
 * answers. The playbook decides that, never a field on the employee
 * (Backend f79f1e6c), so this tab reads it and says where it is changed.
 */
export default async function Page({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}) {
  const t = await getTranslations('employees');
  const tch = await getTranslations('channels');
  const { id } = await params;
  const [read, reachable] = await Promise.all([loadEmployeePage(id), loadReachability(id)]);
  const { employee } = read;

  if (!employee) {
    return (
      <PageContainer layout="screen" flush>
        <p className={styles.unread} role="status" data-testid="employee-page-unread">
          {read.missing ? t('page.missing') : t('page.unread')}
        </p>
      </PageContainer>
    );
  }

  // The Website widget is one row, as the channel list draws it.
  const reach = reachable
    ? foldWidget(reachable).map((c) => ({
        channel: c.widget ? 'WEBCHAT' : c.channel,
        name: c.widget ? tch('widgetRow.name') : (channelName(c.channel, tch) ?? tch('name.other')),
        when: t(`reach.${c.reach}`),
      }))
    : null;

  return (
    <PageContainer layout="screen" flush>
      <div className={tab.tab}>
        <header className={tab.head}>
          <EmployeeHead employee={employee} />
        </header>
        <EmployeeTabs id={id} current="channels" skillsCount={read.skillsCount} />
        <div className={styles.scroll}>
          <div className={styles.list} data-testid="employee-channels">
            <section className={styles.section}>
              <h2 className={styles.title}>{t('detail.answersOn.title')}</h2>
              <WhoAnswers
                className={styles.quiet}
                text={t.rich('whoAnswers', { automations: automationsLink })}
                reach={reach}
                where={t.rich('reach.where', { automations: automationsLink })}
                nowhere={t.rich('reach.nowhere', { automations: automationsLink })}
              />
            </section>
          </div>
        </div>
      </div>
    </PageContainer>
  );
}

export const generateMetadata = pageMetadata('studio.employees');
