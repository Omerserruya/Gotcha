import { getTranslations } from 'next-intl/server';

import { loadTemplates } from '@/features/outreach/load-templates';
import styles from '@/features/outreach/Outreach.module.css';
import {
  RejectedCard,
  selectedGroup,
  TemplatePreview,
  TemplateTable,
  templateGroups,
  WorthKnowing,
} from '@/features/outreach/TemplateList';
import { PageContainer } from '@/shell/PageContainer';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * Screen 05c — message templates.
 *
 * Measured: the table card and a 440 column inside `padding:22px 40px 30px`,
 * `gap:14px`, each card filling the panel's height and scrolling inside
 * itself. `?template=` chooses the preview, and the URL keeps it.
 *
 * Every state draws the same frame: a failed read and an empty list each say
 * so in the table's body, and the column keeps its cards.
 */
export default async function Page({
  searchParams,
}: {
  readonly searchParams?: Promise<{ readonly template?: string }>;
}) {
  const t = await getTranslations('templates');
  const { template: wanted } = (await searchParams) ?? {};
  const { templates } = await loadTemplates();
  const groups = templates === null ? null : templateGroups(templates);
  const selected = groups === null ? null : selectedGroup(groups, wanted);

  return (
    <PageContainer layout="screen" flush title={t('title')} description={t('description')}>
      <div className={styles.tplScreen} data-testid="templates-screen">
        <TemplateTable groups={groups} selectedId={selected?.primary.id ?? null} />
        <div className={styles.tplColumn}>
          <TemplatePreview group={selected} />
          {groups ? <RejectedCard groups={groups} /> : null}
          <WorthKnowing />
        </div>
      </div>
    </PageContainer>
  );
}

export const generateMetadata = pageMetadata('primary.outreach');
