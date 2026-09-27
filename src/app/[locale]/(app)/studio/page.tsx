import { getTranslations } from 'next-intl/server';

import { StudioIndex } from '@/features/studio/StudioIndex';
import { PageContainer } from '@/shell/PageContainer';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * Studio — the index for its four areas.
 *
 * This was an 18-line placeholder that rendered a title and nothing else, and
 * it is the one route a browser walk of all 27 screens reported as empty.
 *
 * ── WHY AN INDEX AND NOT A REDIRECT TO THE FIRST AREA ──
 * A redirect would make `/studio` mean `/studio/employees`, and then the
 * sidebar's "Studio" entry would highlight Employees for somebody who clicked
 * Studio. It also hides the fact that there are four areas from anybody who
 * arrives from a link rather than from the sidebar.
 *
 * ── AND THE INDEX IS A CLIENT COMPONENT FOR ONE REASON ──
 * Permissions. Every area is gated, and `canSee` lives in the client context the
 * sidebar uses, so this way the index and the sidebar cannot disagree about what
 * exists. The alternative — resolving the permission set again on the server —
 * is a second answer to the same question.
 */
export default async function Page() {
  const t = await getTranslations('studio');
  return (
    <PageContainer title={t('title')} description={t('description')}>
      <StudioIndex />
    </PageContainer>
  );
}

export const generateMetadata = pageMetadata('primary.studio');
