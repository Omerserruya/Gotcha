import type { ReactNode } from 'react';

import { Link } from '@/i18n/navigation';

import styles from './SettingsSection.module.css';

/**
 * The opening of a Settings section: what it is, in one line.
 *
 * Every screen from 11 to 18 starts this way, and the line is doing work
 * rather than decorating - "GOTCHA never pings you for an incoming message"
 * tells someone what this page will not do before they look for the switch.
 *
 * Measured against 11-18: a ROW across the section's 888 — the title at 02's
 * screen size (26/600, tracked) over a 13px muted line that does not wrap
 * early, and the section's action on the right, on the row's bottom edge
 * ("Invite someone", "Create role", "Read the docs ↗"). A sub-page carries
 * its way back above the title ("← Usage & billing", 17b).
 */
export function SettingsSection({
  title,
  description,
  actions,
  back,
  children,
}: {
  /** Already translated. */
  title: string;
  /** Omitted where the design's line is data rather than copy. */
  description?: string;
  /** The section's own action, on the header's right. */
  actions?: ReactNode;
  /** A sub-page's way back: where, and its already-translated label. */
  back?: { readonly href: string; readonly label: string };
  children?: ReactNode;
}) {
  return (
    <>
      <div className={styles.header}>
        <div className={styles.heading}>
          {back ? (
            <Link href={back.href} className={styles.back} data-testid="settings-back">
              ← {back.label}
            </Link>
          ) : null}
          <h1 className={styles.title}>{title}</h1>
          {description ? <p className={styles.description}>{description}</p> : null}
        </div>
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </div>
      {children ? <div className={styles.body}>{children}</div> : null}
    </>
  );
}
