import type { ReactNode } from 'react';

import { Text } from '@/design-system/primitives/text/Text';

import styles from './PageContainer.module.css';

/**
 * The standard page frame.
 *
 * Every product page uses this, so that page padding, maximum width and the
 * title/action arrangement are decided once. `bleed` is the escape hatch for
 * pages that own their own scroll region - the Inbox being the obvious one.
 */
export function PageContainer({
  title,
  description,
  actions,
  bleed,
  children,
}: {
  /** Already translated. */
  title?: string;
  description?: string;
  actions?: ReactNode;
  bleed?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={[styles.container, bleed && styles.bleed].filter(Boolean).join(' ')}>
      {title ? (
        <div className={styles.header}>
          <div className={styles.headerText}>
            <Text role="title" as="h1">
              {title}
            </Text>
            {description ? (
              <Text role="body" tone="muted">
                {description}
              </Text>
            ) : null}
          </div>
          {actions}
        </div>
      ) : null}
      {children}
    </div>
  );
}
