import { getTranslations } from 'next-intl/server';

import { PageContainer } from '@/shell/PageContainer';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * Route placeholder.
 *
 * The route, its layout slot and its translated title exist so navigation is
 * real and testable. There is no product content here yet: this area is built
 * once its UX and API contract are defined.
 */
export default async function Page() {
  const t = await getTranslations('navigation');
  return <PageContainer title={t('primary.inbox')} />;
}

export const generateMetadata = pageMetadata('primary.inbox');
