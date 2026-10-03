import type { ReactNode } from 'react';

import styles from './StudioSplit.module.css';

/**
 * Studio's frame under the header (07, 09, 10): a list on the left, the
 * selected item's detail beside it. Measured — 07 and 09: list 330, detail
 * the rest (888); 10: list 290. Each pane scrolls inside itself; the frame
 * does not scroll (it sits in `PageContainer flush`).
 */
export function StudioSplit({
  list,
  detail,
  listWidth = 'wide',
  detailPad = 'regular',
  label,
}: {
  readonly list: ReactNode;
  readonly detail: ReactNode;
  /** `wide` 330 (07, 09) · `narrow` 290 (10). */
  readonly listWidth?: 'wide' | 'narrow';
  /**
   * `regular` `30px 40px`, gap 16 (07) · `snug` `28px 36px`, gap 18 (09) ·
   * `wide` `26px 36px`, gap 16 (10).
   */
  readonly detailPad?: 'regular' | 'snug' | 'wide';
  /** The list's accessible name. */
  readonly label: string;
}) {
  return (
    <div className={styles.split}>
      <nav className={styles.list} data-width={listWidth} aria-label={label}>
        {list}
      </nav>
      <section className={styles.detail} data-pad={detailPad} data-testid="studio-detail">
        {detail}
      </section>
    </div>
  );
}
