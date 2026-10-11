'use client';

import { useRef, type ReactNode } from 'react';

import { pressSheetClose, useSheetFocus } from '@/design-system/primitives/overlay/use-sheet-focus';

import styles from '@/design-system/styles/drawer.module.css';

/**
 * The drawer's panel, as a modal dialog (supervisor, 2026-10-11: Escape did
 * nothing on `?panel=`). Focus moves in, stays in, and goes back to the row
 * that opened it; Escape presses the drawer's own × - the same navigation,
 * so there is one way out, not two that could drift apart.
 */
export function DrawerPanel({
  label,
  width,
  children,
}: {
  readonly label: string;
  readonly width: number;
  readonly children: ReactNode;
}) {
  const panel = useRef<HTMLElement>(null);
  useSheetFocus(panel, { onEscape: () => pressSheetClose(panel.current) });
  return (
    <aside
      ref={panel}
      className={styles.panel}
      data-width={width}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
    >
      {children}
    </aside>
  );
}
