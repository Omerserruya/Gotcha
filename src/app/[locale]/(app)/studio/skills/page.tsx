import { Suspense } from 'react';

import { SKILL_CATEGORIES, type SkillCategory } from '@/api/contracts/skills';
import { SkillsLibraryPending } from '@/features/skills/SkillsLibrary';
import { LibrarySection } from '@/features/skills/SkillsPage';
import { pageMetadata } from '@/shell/page-metadata';

import { SkillsFrame } from './frame';

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
  const params = (await searchParams) ?? {};
  const category = (SKILL_CATEGORIES as readonly string[]).includes(params.category ?? '')
    ? (params.category as SkillCategory)
    : null;
  // 21 opens over 09, as `?new=1`; its employees are read only then.
  const creating = params.new === '1';

  return (
    <SkillsFrame archived={params.archived === '1'}>
      {/* The header, buttons and note draw at once; the library when it is read. */}
      <Suspense fallback={<SkillsLibraryPending />}>
        <LibrarySection category={category} creating={creating} />
      </Suspense>
    </SkillsFrame>
  );
}

export const generateMetadata = pageMetadata('studio.skills');
