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
  layout = 'document',
  fill = false,
  flush = false,
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
  /**
   * ════════════════════════════════════════════════════════════════════════
   * ★★ `screen` — 02's PAGE, NOT A DOCUMENT
   * ════════════════════════════════════════════════════════════════════════
   * Measured on Approvals, Customers, Outreach and Analytics alike: the
   * header is a ROW across the full panel at `padding:30px 40px 20px` — a
   * 26px/600 title over a 13px `#6B6660` line, and the page's stats, actions
   * or tabs on the right, sitting on the header's bottom edge. The content
   * runs the panel's full width at 40px either side. `document` (the
   * default) is a column centred at 1120, which is right for settings and
   * wrong for a screen of cards.
   */
  layout?: 'document' | 'screen';
  /**
   * `screen` only. ★★ THE BODY IS A WINDOW, NOT A DOCUMENT.
   *
   * Omer's rule from the inbox — "every container is a window you scroll
   * inside, not outside" — for the other screens. With `fill`, the body takes
   * exactly the rest of the panel's height, so the header stays put and the
   * page's own card scrolls INSIDE itself. Measured on 03c: our card was 1175
   * tall on a 900 viewport and the whole panel scrolled, header and all.
   *
   * The convention for what goes inside (`fill.module.css`): the card that
   * should take the remaining height is `fillCard` (`flex: 1; min-block-size:
   * 0`), and its list is `fillScroll` — the scroller.
   */
  fill?: boolean;
  /**
   * `screen` only: `fill`, and no padding either — for columns that run to
   * the panel's edges, as 03's queue does (`[300x775]` from the header down).
   */
  flush?: boolean;
  children?: ReactNode;
}) {
  if (layout === 'screen') {
    return (
      <div
        className={[styles.screen, (fill || flush) && styles.screenFill].filter(Boolean).join(' ')}
      >
        {title ? (
          <header className={styles.screenHeader}>
            <div className={styles.screenHeading}>
              <h1 className={styles.screenTitle}>{title}</h1>
              {description ? <p className={styles.screenDescription}>{description}</p> : null}
            </div>
            {actions ? <div className={styles.screenAside}>{actions}</div> : null}
          </header>
        ) : null}
        <div
          className={
            flush
              ? styles.screenBodyFlush
              : [styles.screenBody, fill && styles.screenBodyFill].filter(Boolean).join(' ')
          }
        >
          {children}
        </div>
      </div>
    );
  }

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
