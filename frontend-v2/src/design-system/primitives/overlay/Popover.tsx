'use client';

import { Popover as RadixPopover } from 'radix-ui';
import type { ComponentPropsWithoutRef } from 'react';

import styles from './overlay.module.css';

export const Popover = RadixPopover.Root;
export const PopoverTrigger = RadixPopover.Trigger;
export const PopoverClose = RadixPopover.Close;

/**
 * Popover: a non-modal floating panel that may hold interactive content.
 *
 * Use it where a dialog would be too heavy and a tooltip too slight - a filter
 * panel, a quick edit. Unlike a dialog it does not trap focus, so the page
 * behind stays usable.
 */
export function PopoverContent({
  children,
  align = 'start',
  sideOffset = 6,
  ...rest
}: ComponentPropsWithoutRef<typeof RadixPopover.Content>) {
  return (
    <RadixPopover.Portal>
      <RadixPopover.Content
        className={[styles.surface, styles.popoverSurface].join(' ')}
        align={align}
        sideOffset={sideOffset}
        collisionPadding={8}
        {...rest}
      >
        {children}
      </RadixPopover.Content>
    </RadixPopover.Portal>
  );
}
