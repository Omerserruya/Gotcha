import { getTranslations } from 'next-intl/server';

import { loadSkill, loadSkillEmployees } from '@/features/skills/load-skills';
import { SkillEditor } from '@/features/skills/SkillEditor';
import styles from '@/features/skills/SkillEditor.module.css';
import { PageContainer } from '@/shell/PageContainer';
import { pageMetadata } from '@/shell/page-metadata';

/** 09b - Studio · Skills · Edit a skill (design 6). */
export default async function Page({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}) {
  const t = await getTranslations('skills');
  const { id } = await params;
  const [read, employees] = await Promise.all([loadSkill(id), loadSkillEmployees()]);

  return (
    <PageContainer layout="screen" flush>
      {read.skill ? (
        <SkillEditor
          skill={read.skill}
          employees={employees}
          tools={read.tools}
          otherSkills={read.others}
        />
      ) : (
        <p className={styles.unread} role="status" data-testid="skill-unread">
          {read.missing ? t('notFound') : t('unread')}
        </p>
      )}
    </PageContainer>
  );
}

export const generateMetadata = pageMetadata('studio.skills');
