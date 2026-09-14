import type { ReactNode } from 'react';

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
 */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div className={styles.split}>
      <SettingsSections />
      <div className={styles.section}>{children}</div>
    </div>
  );
}
