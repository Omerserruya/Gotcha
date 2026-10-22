import { useTranslations } from 'next-intl';

import { Loader } from '@/design-system/primitives/loader/Loader';
import { Text } from '@/design-system/primitives/text/Text';
import styles from '@/features/account/VerifyEmail.module.css';
import { PageContainer } from '@/shell/PageContainer';

/**
 * The confirmation's own first frame, the moment the link opens: the page's
 * "working" state, drawn before the page answers, so nothing changes shape
 * when it does.
 */
export default function Loading() {
  const t = useTranslations('security.verifyEmail');
  return (
    <PageContainer>
      <div className={styles.panel} data-testid="verify-email-loading" aria-busy="true">
        <Loader size={32} label={t('working')} />
        <Text role="body" tone="muted" as="p">
          {t('working')}
        </Text>
      </div>
    </PageContainer>
  );
}
