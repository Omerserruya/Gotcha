import type { ReactNode } from 'react';

import { ConsoleSections } from '@/shell/ConsoleSections';
import { requireConsole } from '@/shell/require-console';

import styles from './layout.module.css';

/**
 * The platform console (legacy `/system`, `SystemLayout.tsx`).
 *
 * SYSTEM_ADMIN only, decided here on the server before anything is drawn:
 * anyone else gets the app's "not found", never a frame of the console.
 * Inside, Settings' split - the sections in a light sidebar, the page beside.
 */
export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  await requireConsole();
  return (
    <div className={styles.split}>
      <ConsoleSections />
      <div className={styles.section}>{children}</div>
    </div>
  );
}
