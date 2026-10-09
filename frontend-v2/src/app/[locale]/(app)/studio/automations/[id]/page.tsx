import { getTranslations } from 'next-intl/server';

import { Builder } from '@/features/automations/Builder';
import styles from '@/features/automations/Builder.module.css';
import { loadBuilder, loadCatalog } from '@/features/automations/load-automations';
import { PageContainer } from '@/shell/PageContainer';
import { pageMetadata } from '@/shell/page-metadata';

/** 09d - Studio · Automations · Builder (design 6). */
export default async function Page({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}) {
  const t = await getTranslations('automations');
  const { id } = await params;
  const [read, catalog] = await Promise.all([loadBuilder(id), loadCatalog({ automationId: id })]);

  return (
    <PageContainer layout="screen" flush>
      {read.automation ? (
        <Builder
          automation={read.automation}
          catalog={catalog}
          stats={read.stats}
          webhook={read.webhook}
          choices={{
            employees: read.employees,
            teams: read.teams,
            members: read.members,
            skills: read.skills,
            templates: read.templates,
          }}
        />
      ) : (
        <p className={styles.unread} role="status" data-testid="builder-unread">
          {read.forbidden
            ? t('forbidden.title')
            : read.missing
              ? t('builder.notFound')
              : t('builder.unread')}
        </p>
      )}
    </PageContainer>
  );
}

export const generateMetadata = pageMetadata('studio.automations');
