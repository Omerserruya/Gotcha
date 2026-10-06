import { useTranslations } from 'next-intl';

import { CenteredLoader } from '@/design-system/primitives/loader/Loader';
import { PageContainer } from '@/shell/PageContainer';

/**
 * Every app route before its first read: the GOTCHA loader in the middle of
 * the card, inside the shell (Omer, 2026-10-06). The rail is the layout's and
 * stays, so a navigation never flashes white. The inbox has its own, drawn in
 * the shape of its lists.
 */
export default function Loading() {
  const t = useTranslations('common');
  return (
    // `screen` + `flush`: the body is the card's whole remaining height, and the loader fills it.
    <PageContainer layout="screen" flush>
      <CenteredLoader size={56} fill label={t('loading')} />
    </PageContainer>
  );
}
