'use client';

import { Dialog as RadixDialog, VisuallyHidden } from 'radix-ui';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';

import styles from './overlay.module.css';

export const Dialog = RadixDialog.Root;
export const DialogTrigger = RadixDialog.Trigger;
export const DialogClose = RadixDialog.Close;

/**
 * Modal dialog.
 *
 * A title is required, not optional. A dialog without an accessible name is
 * announced as an unlabelled group, which leaves a screen-reader user inside a
 * focus trap with no idea what opened. `hideTitle` renders it for assistive
 * technology only when the design calls for no visible heading.
 */
export function DialogContent({
  title,
  description,
  hideTitle,
  children,
  ...rest
}: ComponentPropsWithoutRef<typeof RadixDialog.Content> & {
  title: string;
  description?: string;
  hideTitle?: boolean;
}) {
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className={styles.dialogOverlay} />
      <RadixDialog.Content className={styles.dialogContent} {...rest}>
        {hideTitle ? (
          <VisuallyHidden.Root>
            <RadixDialog.Title>{title}</RadixDialog.Title>
          </VisuallyHidden.Root>
        ) : (
          <RadixDialog.Title>{title}</RadixDialog.Title>
        )}
        {description ? <RadixDialog.Description>{description}</RadixDialog.Description> : null}
        {children}
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
}

/**
 * Drawer.
 *
 * Shares Dialog's semantics and focus management, differing only in where it
 * sits. It enters from the inline-end edge, so it slides from the right in
 * English and from the left in Hebrew with no branching.
 */
export const Drawer = RadixDialog.Root;
export const DrawerTrigger = RadixDialog.Trigger;
export const DrawerClose = RadixDialog.Close;

export function DrawerContent({
  title,
  hideTitle,
  children,
  ...rest
}: ComponentPropsWithoutRef<typeof RadixDialog.Content> & {
  title: string;
  hideTitle?: boolean;
  children: ReactNode;
}) {
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className={styles.dialogOverlay} />
      <RadixDialog.Content className={styles.drawerContent} {...rest}>
        {hideTitle ? (
          <VisuallyHidden.Root>
            <RadixDialog.Title>{title}</RadixDialog.Title>
          </VisuallyHidden.Root>
        ) : (
          <RadixDialog.Title>{title}</RadixDialog.Title>
        )}
        {children}
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
}

/**
 * Bottom sheet - the phone's dialog (`GOTCHA Mobile App.dc.html`: a white
 * sheet from the bottom edge, radius 26 on its top corners, a handle, the
 * screen dimmed behind it). Dialog's semantics and focus trap; only the
 * place differs, so a phone and a desktop dialog behave as one thing.
 */
export const Sheet = RadixDialog.Root;
export const SheetTrigger = RadixDialog.Trigger;
export const SheetClose = RadixDialog.Close;

export function SheetContent({
  title,
  hideTitle,
  children,
  ...rest
}: ComponentPropsWithoutRef<typeof RadixDialog.Content> & {
  title: string;
  hideTitle?: boolean;
  children: ReactNode;
}) {
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className={styles.sheetOverlay} />
      <RadixDialog.Content className={styles.sheetContent} aria-describedby={undefined} {...rest}>
        <span className={styles.sheetHandle} aria-hidden="true" />
        {hideTitle ? (
          <VisuallyHidden.Root>
            <RadixDialog.Title>{title}</RadixDialog.Title>
          </VisuallyHidden.Root>
        ) : (
          <RadixDialog.Title className={styles.sheetTitle}>{title}</RadixDialog.Title>
        )}
        {children}
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
}
