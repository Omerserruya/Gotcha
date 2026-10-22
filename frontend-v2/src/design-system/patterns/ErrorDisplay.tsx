'use client';

import { useTranslations } from 'next-intl';

import { Button } from '@/design-system/primitives/button/Button';
import { presentError } from '@/observability/error-presentation';

import { StateDisplay } from './StateDisplay';

/**
 * Renders a failure using the product's shared error vocabulary.
 *
 * Copy comes from the `errors` namespace keyed by failure kind, so every
 * surface says the same thing about the same problem, in the user's language.
 * The backend's own message is never shown: it is English, written for
 * engineers, and often describes an internal detail.
 */
export function ErrorDisplay({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const t = useTranslations('errors');
  const presented = presentError(error);

  return (
    <StateDisplay
      tone="danger"
      title={t(presented.titleKey)}
      description={t(presented.bodyKey)}
      reference={
        presented.requestId ? t('referenceId', { requestId: presented.requestId }) : undefined
      }
      actions={
        presented.retryable && onRetry ? (
          <Button variant="secondary" onClick={onRetry}>
            {t('boundary.recover')}
          </Button>
        ) : null
      }
    />
  );
}
