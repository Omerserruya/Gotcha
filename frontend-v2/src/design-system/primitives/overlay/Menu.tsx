'use client';

import { Check } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';

import styles from './overlay.module.css';

/**
 * Dropdown menu.
 *
 * Built on Radix rather than hand-rolled. What is being bought is behaviour,
 * not looks: focus trapping, roving focus, type-ahead, escape and outside
 * click, collision-aware placement, `aria-expanded`/`aria-controls` wiring,
 * and correct side/align flipping under RTL when a `DirectionProvider` is
 * present. Reimplementing that correctly is weeks of work and is the part
 * users with a keyboard or a screen reader depend on entirely.
 *
 * The appearance is entirely ours - Radix ships unstyled.
 */
export const Menu = DropdownMenu.Root;
export const MenuTrigger = DropdownMenu.Trigger;

export function MenuContent({
  children,
  align = 'start',
  sideOffset = 6,
  ...rest
}: ComponentPropsWithoutRef<typeof DropdownMenu.Content>) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        className={styles.surface}
        align={align}
        sideOffset={sideOffset}
        collisionPadding={8}
        {...rest}
      >
        {children}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  );
}

export function MenuItem({
  children,
  tone = 'default',
  ...rest
}: ComponentPropsWithoutRef<typeof DropdownMenu.Item> & { tone?: 'default' | 'danger' }) {
  return (
    <DropdownMenu.Item
      className={[styles.item, tone === 'danger' && styles.itemDanger].filter(Boolean).join(' ')}
      {...rest}
    >
      {children}
    </DropdownMenu.Item>
  );
}

/**
 * One choice of several, the current one checked: `role="menuitemradio"`
 * with `aria-checked`, and a check mark at the item's end. The group owns
 * which one is current (`value`) and hears the choice (`onValueChange`) -
 * including a choice of the one already checked, which Radix reports too.
 */
export const MenuRadioGroup = DropdownMenu.RadioGroup;

export function MenuRadioItem({
  children,
  ...rest
}: ComponentPropsWithoutRef<typeof DropdownMenu.RadioItem>) {
  return (
    <DropdownMenu.RadioItem className={styles.item} {...rest}>
      {children}
      <DropdownMenu.ItemIndicator className={styles.itemCheck}>
        <Check size={13} aria-hidden="true" />
      </DropdownMenu.ItemIndicator>
    </DropdownMenu.RadioItem>
  );
}

export function MenuSeparator() {
  return <DropdownMenu.Separator className={styles.separator} />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <DropdownMenu.Label className={styles.label}>{children}</DropdownMenu.Label>;
}
