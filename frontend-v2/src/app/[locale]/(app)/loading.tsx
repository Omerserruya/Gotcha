import { useTranslations } from 'next-intl';

import { SkeletonRows } from '@/design-system/primitives/skeleton/Skeleton';
import { PageContainer } from '@/shell/PageContainer';

/**
 * Every app route before its page answers: placeholders, not the loader
 * (Omer, 2026-10-07 - the GOTCHA loader is for before the shell and for
 * blocking actions). The rail is the layout's and stays. Pages draw their
 * static parts at once and hold placeholders per section; the inbox has
 * its own, in the shape of its lists.
 */
export default function Loading() {
  const t = useTranslations('common');
  return (
    // Rows in the card, where a page's content will land. Its own title and
    // buttons are the page's: they draw the moment the page answers.
    <PageContainer layout="screen">
      <SkeletonRows label={t('loading')} rows={8} testid="route-skeleton" />
    </PageContainer>
  );
}
