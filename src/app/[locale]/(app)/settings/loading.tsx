import { useTranslations } from 'next-intl';

import { CenteredLoader } from '@/design-system/primitives/loader/Loader';
import { PageContainer } from '@/shell/PageContainer';

/**
 * A settings page before its first read: as `(app)/loading.tsx`, one level
 * in, so the settings navigation (this segment's layout) stays on screen.
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
