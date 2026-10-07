import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';

import { SKILL_CATEGORIES, type SkillCategory } from '@/api/contracts/skills';
import { loadSkillEmployees, loadSkillsLibrary } from '@/features/skills/load-skills';
import { NewSkill } from '@/features/skills/NewSkill';
import { SkillsLibrary, SkillsLibraryPending } from '@/features/skills/SkillsLibrary';
import styles from '@/features/skills/Skills.module.css';
import { Link } from '@/i18n/navigation';
import { PageContainer } from '@/shell/PageContainer';
import { pageMetadata } from '@/shell/page-metadata';

/** 09 - Studio · Skills (design 6). `?category=` filters, as 09's pills do. */
export default async function Page({
  searchParams,
}: {
  readonly searchParams?: Promise<{
    readonly category?: string;
    readonly new?: string;
    /** Back from 09b's Archive: one line saying it happened. */
    readonly archived?: string;
  }>;
} = {}) {
  const t = await getTranslations('skills');
  const params = (await searchParams) ?? {};
  const category = (SKILL_CATEGORIES as readonly string[]).includes(params.category ?? '')
    ? (params.category as SkillCategory)
    : null;
  // 21 opens over 09, as `?new=1`; its employees are read only then.
  const creating = params.new === '1';

  return (
    <PageContainer
      layout="screen"
      headerPadEnd={22}
      title={t('title')}
      description={t('description')}
      actions={
        <span className={styles.headerActions}>
          {/* Templates are the next phase of skills: drawn, and saying so. */}
          <button
            type="button"
            className={styles.secondary}
            disabled
            title={t('fromTemplateWhy')}
            data-testid="skills-from-template"
          >
            {t('fromTemplate')}
          </button>
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
      {params.archived === '1' ? (
        <p className={styles.archivedNote} role="status" data-testid="skills-archived">
          {t('editor.archive.done')}
        </p>
      ) : null}
      {/* The header, buttons and note draw at once; the library when it is read. */}
      <Suspense fallback={<SkillsLibraryPending />}>
        <LibrarySection category={category} creating={creating} />
      </Suspense>
    </PageContainer>
  );
}

/** 09's data: the library, and - with 21 open - who it can be given to. */
export async function LibrarySection({
  category,
  creating,
}: {
  readonly category: SkillCategory | null;
  readonly creating: boolean;
}) {
  const [{ skills, tools }, employees] = await Promise.all([
    loadSkillsLibrary(),
    creating ? loadSkillEmployees() : Promise.resolve(null),
  ]);
  return (
    <>
      <SkillsLibrary skills={skills} tools={tools} category={category} />
      {creating ? (
        <NewSkill
          employees={employees}
          tools={tools ? [...tools.values()] : null}
          otherSkills={(skills ?? [])
            .filter((s) => s.status !== 'archived')
            .map((s) => ({ id: s.id, name: s.name }))}
        />
      ) : null}
    </>
  );
}

export const generateMetadata = pageMetadata('studio.skills');
