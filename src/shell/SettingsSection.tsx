import type { ReactNode } from 'react';

import styles from './SettingsSection.module.css';

/**
 * The opening of a Settings section: what it is, in one line.
 *
 * Every screen from 11 to 18 starts this way, and the line is doing work
 * rather than decorating - "GOTCHA never pings you for an incoming message"
 * tells someone what this page will not do before they look for the switch.
 */
export function SettingsSection({
  title,
  description,
  children,
}: {
  /** Already translated. */
  title: string;
  /** Omitted where the design's line is data rather than copy. */
  description?: string;
  children?: ReactNode;
}) {
  return (
    <>
      <div className={styles.header}>
        <h1 className={styles.title}>{title}</h1>
        {description ? <p className={styles.description}>{description}</p> : null}
      </div>
      {children ? <div className={styles.body}>{children}</div> : null}
    </>
  );
}
