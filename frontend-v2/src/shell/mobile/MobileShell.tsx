import type { ReactNode } from 'react';

import styles from './MobileShell.module.css';
import { MobileInboundBanner } from './MobileInboundBanner';
import { MobileTabs } from './MobileTabs';
import { NativeBridge } from './NativeBridge';

/**
 * The phone's frame: the screen, and four tabs under it.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ NO RAIL, NO COMMAND PALETTE, NO SETTINGS
 * ════════════════════════════════════════════════════════════════════════════
 * Omer's scope (2026-11-02): the app is the inbox, approvals, outreach and
 * customers, and everything else stays on the website. So the frame carries
 * exactly those four, and a link to anything else leaves the app (the native
 * shell opens it in the system browser).
 *
 * Each screen draws its own top bar, as WhatsApp does: the list's bar names
 * the screen, a conversation's bar is the person with a way back. A shared
 * bar here would have to know which of the two it was.
 */
export function MobileShell({
  children,
  meId = null,
}: {
  readonly children: ReactNode;
  /** Who is looking, for the incoming-message banner (`MobileInboundBanner`). */
  readonly meId?: string | null;
}) {
  return (
    <div className={styles.frame} data-mobile-shell="">
      {/* Renders nothing: push registration and notification taps, inside the app only. */}
      <NativeBridge />
      <MobileInboundBanner meId={meId} />
      <main id="main-content" className={styles.main} tabIndex={-1}>
        {children}
      </main>
      <MobileTabs />
    </div>
  );
}
