import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

import { UnavailableAction } from '@/design-system/primitives/unavailable/Unavailable';
import styles from '@/features/skills/Skills.module.css';
import { Link } from '@/i18n/navigation';
import { PageContainer } from '@/shell/PageContainer';

/**
 * 09's static frame - the title, the buttons, the archived note - shared by
 * the page and its `loading.tsx`, so the frame a navigation shows at once is
 * the page's own.
 */
export function SkillsFrame({
  archived,
  children,
}: {
  readonly archived: boolean;
  readonly children: ReactNode;
}) {
  const t = useTranslations('skills');
  return (
    <PageContainer
      layout="screen"
      headerPadEnd={22}
      title={t('title')}
      description={t('description')}
      actions={
        <span className={styles.headerActions}>
          {/* Templates are the next phase of skills: drawn, and saying so. */}
          <UnavailableAction
            label={t('fromTemplate')}
            tag={t('notYet')}
            why={t('fromTemplateWhy')}
            testid="skills-from-template"
          />
          <Link
            href={{ pathname: '/studio/skills', query: { new: '1' } }}
            className={styles.primary}
            scroll={false}
            data-testid="skills-describe"
          >
            {t('describe')}
          </Link>
        </span>
      }
    >
      {archived ? (
        <p className={styles.archivedNote} role="status" data-testid="skills-archived">
          {t('editor.archive.done')}
        </p>
      ) : null}
      {children}
    </PageContainer>
  );
}
