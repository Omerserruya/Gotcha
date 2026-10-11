import type { ReactNode } from 'react';

import { RowTipForward } from '@/shell/RowTipForward';
import { SettingsFootnote } from '@/shell/SettingsFootnote';
import { SettingsSections } from '@/shell/SettingsSections';

import styles from './layout.module.css';

/**
 * Settings splits the work surface.
 *
 * Its eight sections sit in a light sidebar inside the panel rather than in
 * the dark rail, which is how screens 11-18 draw it: Inbox and Studio reveal
 * filters over one page, while a Settings section is a page of its own.
 *
 * Each section scrolls on its own, so moving between them does not carry the
 * previous one's scroll position across.
 *
 * A GRID rather than a row, because the three pieces want different orders at
 * different widths and CSS should decide that, not the markup. Wide: sections
 * and their footnote stack in the first column, the page fills the second.
 * Narrow: the sections become a strip along the top, the PAGE comes next, and
 * the footnote falls to the bottom. Written once here, it is the shape every
 * Settings screen gets.
 */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div className={styles.split}>
      <SettingsSections />
      <div className={styles.section}>{children}</div>
      <RowTipForward />
      <div className={styles.footnote}>
        <SettingsFootnote />
      </div>
    </div>
  );
}
