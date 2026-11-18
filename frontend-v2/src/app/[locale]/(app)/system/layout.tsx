import type { ReactNode } from 'react';

import { loadAiAlertCount } from '@/features/console/load-ai-failures';
import { ConsoleSections } from '@/shell/ConsoleSections';
import { ConsoleUnread } from '@/shell/ConsoleUnread';
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
  /*
    ★★ Unread is a 200 page with a Try again, never a 404 or a redirect: one
    console tab re-asking for this page 4-5 times a second throttled every
    customer's server calls on prod (2026-11-16, `BackoffRetry`).
  */
  if ((await requireConsole()) === 'unread') return <ConsoleUnread />;
  // The AI failures over Backend's threshold in the last hour (Omer, 2026-11-18): console only.
  const alerts = await loadAiAlertCount();
  return (
    <div className={styles.split}>
      <ConsoleSections badges={alerts ? { 'ai-failures': alerts } : {}} />
      <div className={styles.section}>{children}</div>
    </div>
  );
}
