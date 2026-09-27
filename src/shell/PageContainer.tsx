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
  wide,
  children,
}: {
  /** Already translated. */
  title?: string;
  description?: string;
  actions?: ReactNode;
  bleed?: boolean;
  /**
   * Relax the reading-width cap for a screen that is columns rather than prose.
   *
   * ════════════════════════════════════════════════════════════════════════
   * ★★ WHY NOT `bleed`, WHOSE COMMENT NAMES THE INBOX
   * ════════════════════════════════════════════════════════════════════════
   * `bleed` does three things: removes the cap, removes the padding, and sets
   * `block-size: 100%`. The last two are for a page that owns its own scroll
   * region, and the Inbox does not — it scrolls with the work surface like every
   * other screen. Taking all three to get the first would change scrolling on
   * the busiest screen in the product for a width problem.
   *
   * The width alone was the problem: 1120px minus 80px of padding, minus a
   * 210px rail and a 300px context column and two gaps, left the conversation
   * column at **about 500 pixels** on a 1440 display. A prose cap is right for
   * a settings page and wrong for three columns.
   *
   * If the Inbox later takes over its own scrolling, `bleed` is the right prop
   * and this one should go.
   */
  wide?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      className={[styles.container, bleed && styles.bleed, wide && styles.wide]
        .filter(Boolean)
        .join(' ')}
    >
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
