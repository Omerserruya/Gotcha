import { getTranslations } from 'next-intl/server';

import { PageContainer } from '@/shell/PageContainer';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * Route placeholder.
 *
 * The route, its rail entry and its translated title exist so navigation is
 * real and testable. There is no product content here yet: this section is
 * built once its UX and API contract are defined.
 */
export default async function Page() {
  const t = await getTranslations('navigation');
  return <PageContainer title={t('analytics.ai')} />;
}

export const generateMetadata = pageMetadata('analytics.ai');
