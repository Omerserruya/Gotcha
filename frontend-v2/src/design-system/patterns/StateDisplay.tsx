import type { ReactNode } from 'react';

import { Text } from '@/design-system/primitives/text/Text';

import styles from './states.module.css';

export type StateTone = 'neutral' | 'danger' | 'success';

/**
 * The shared shape of an empty, error or success state.
 *
 * One component rather than three near-copies, because the difference between
 * "no conversations yet", "we couldn't load conversations" and "all done" is
 * tone, copy and what the user can do next - not layout. Keeping them together
 * is what stops the three drifting into three different paddings.
 *
 * All copy arrives translated. This component contains no strings.
 */
export function StateDisplay({
  tone = 'neutral',
  icon,
  title,
  description,
  actions,
  reference,
}: {
  tone?: StateTone;
  icon?: ReactNode;
  title: string;
  description?: string;
  actions?: ReactNode;
  /** Correlation id, shown so a user can quote it to support. */
  reference?: string;
}) {
  return (
    <div className={styles.state}>
      {icon ? (
        <span className={[styles.indicator, styles[tone]].join(' ')} aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <Text role="heading" as="h2">
        {title}
      </Text>
      {description ? (
        <Text role="body" tone="secondary">
          {description}
        </Text>
      ) : null}
      {actions ? <div className={styles.actions}>{actions}</div> : null}
      {reference ? <span className={styles.reference}>{reference}</span> : null}
    </div>
  );
}
