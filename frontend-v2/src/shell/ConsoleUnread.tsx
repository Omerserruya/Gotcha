import { useTranslations } from 'next-intl';

import { StateDisplay } from '@/design-system/patterns/StateDisplay';

import { BackoffRetry } from './BackoffRetry';

/**
 * The console when the caller's role could not be read (`requireConsole`
 * answered `'unread'`): say so, and let a person try again. Never "not found"
 * (they may well be an operator) and never the console (they may not be).
 */
export function ConsoleUnread() {
  const t = useTranslations('console.unread');
  return (
    <div data-testid="console-unread">
      <StateDisplay
        tone="danger"
        title={t('title')}
        description={t('body')}
        actions={<BackoffRetry testid="console-retry" />}
      />
    </div>
  );
}
