import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';

import { Link } from '@/i18n/navigation';

import { DrawerPanel } from './DrawerPanel';

import styles from '@/design-system/styles/drawer.module.css';

/**
 * 02's drawer: a panel from the end over a scrim, its head (title, muted
 * line, ×), then whatever the screen puts in it. The URL holds the state
 * (`?panel=`), so the scrim, the × and Escape all go to `closeHref`; the
 * panel is a modal dialog that keeps focus and returns it (DrawerPanel).
 *
 * The body and its footer are the caller's - a form owns its own Save - so
 * they use `drawerBody` / `drawerFoot` from `design-system/styles/drawer.module.css`.
 */
export async function Drawer({
  title,
  line,
  closeHref,
  width = 560,
  testId,
  lead,
  userTitle = false,
  children,
}: {
  readonly title: string;
  /**
   * The title is text somebody wrote (a document's own title), set apart in
   * a `bdi dir="auto"` so Hebrew in an English drawer - or the reverse -
   * keeps its own order.
   */
  readonly userTitle?: boolean;
  readonly line?: string;
  readonly closeHref: string;
  /** 02's widths: 560 (11b, 11c), 600 (12d, 14c), 620 (11d), 820 (14e). */
  readonly width?: 560 | 600 | 620 | 820 | 860;
  readonly testId?: string;
  /** Before the title - 12d's 44px disc. */
  readonly lead?: ReactNode;
  readonly children: ReactNode;
}) {
  const t = await getTranslations('common.actions');
  return (
    <div className={styles.layer} data-testid={testId}>
      <Link href={closeHref} className={styles.scrim} aria-label={t('close')} tabIndex={-1} />
      <DrawerPanel label={title} width={width}>
        <header className={styles.head}>
          {lead}
          <div className={styles.titles}>
            <h2 className={styles.title}>{userTitle ? <bdi dir="auto">{title}</bdi> : title}</h2>
            {line ? <p className={styles.line}>{line}</p> : null}
          </div>
          <Link href={closeHref} className={styles.close} aria-label={t('close')} data-sheet-close>
            <X size={16} aria-hidden="true" />
          </Link>
        </header>
        {children}
      </DrawerPanel>
    </div>
  );
}
