'use client';

import { useTranslations } from 'next-intl';
import { useEffect } from 'react';

import { Button } from '@/design-system/primitives/button/Button';
import { StateDisplay } from '@/design-system/patterns/StateDisplay';
import { reportError } from '@/observability/logger';

/**
 * Route-level error boundary.
 *
 * Catches anything a page throws while rendering. The shell around it survives,
 * so the user keeps their navigation and can leave rather than being stranded
 * on a blank page.
 *
 * The error's own message is reported, never rendered. It is English, written
 * for engineers, and in this product it can quote customer data.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('errors');

  useEffect(() => {
    reportError(error, { region: 'route', digest: error.digest });
  }, [error]);

  return (
    <StateDisplay
      tone="danger"
      title={t('page.title')}
      description={t('kind.unknown.body')}
      reference={error.digest ? t('referenceId', { requestId: error.digest }) : undefined}
      actions={
        <Button variant="primary" onClick={reset}>
          {t('boundary.recover')}
        </Button>
      }
    />
  );
}
