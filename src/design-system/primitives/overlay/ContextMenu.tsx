'use client';

import { ContextMenu as RadixContextMenu } from 'radix-ui';
import type { ComponentPropsWithoutRef } from 'react';

import styles from './overlay.module.css';

/**
 * Right-click context menu.
 *
 * Every action offered here must also be reachable another way. A context menu
 * is invisible to keyboard-first and touch users, so it accelerates work for
 * people who know it exists - it never carries an action's only route.
 */
export const ContextMenu = RadixContextMenu.Root;
export const ContextMenuTrigger = RadixContextMenu.Trigger;

/**
 * `dark` is 02's inbox menu - `#171717`, the panel's dark wall colour. The
 * light default is every other menu in the product.
 */
export type MenuAppearance = 'light' | 'dark';

export function ContextMenuContent({
  children,
  appearance = 'light',
  ...rest
}: ComponentPropsWithoutRef<typeof RadixContextMenu.Content> & {
  readonly appearance?: MenuAppearance;
}) {
  return (
    <RadixContextMenu.Portal>
      <RadixContextMenu.Content
        className={styles.surface}
        data-appearance={appearance}
        collisionPadding={8}
        {...rest}
      >
        {children}
      </RadixContextMenu.Content>
    </RadixContextMenu.Portal>
  );
}

export function ContextMenuItem({
  children,
  tone = 'default',
  ...rest
}: ComponentPropsWithoutRef<typeof RadixContextMenu.Item> & { tone?: 'default' | 'danger' }) {
  return (
    <RadixContextMenu.Item
      className={[styles.item, tone === 'danger' && styles.itemDanger].filter(Boolean).join(' ')}
      {...rest}
    >
      {children}
    </RadixContextMenu.Item>
  );
}

export function ContextMenuSeparator() {
  return <RadixContextMenu.Separator className={styles.separator} />;
}

/** A submenu - 02's "Assign to someone ›". */
export const ContextMenuSub = RadixContextMenu.Sub;

export function ContextMenuSubTrigger({
  children,
  ...rest
}: ComponentPropsWithoutRef<typeof RadixContextMenu.SubTrigger>) {
  return (
    <RadixContextMenu.SubTrigger className={styles.item} {...rest}>
      {children}
      <span className={styles.subArrow} aria-hidden="true">
        ›
      </span>
    </RadixContextMenu.SubTrigger>
  );
}

export function ContextMenuSubContent({
  children,
  appearance = 'light',
  ...rest
}: ComponentPropsWithoutRef<typeof RadixContextMenu.SubContent> & {
  readonly appearance?: MenuAppearance;
}) {
  return (
    <RadixContextMenu.Portal>
      <RadixContextMenu.SubContent
        className={styles.surface}
        data-appearance={appearance}
        collisionPadding={8}
        {...rest}
      >
        {children}
      </RadixContextMenu.SubContent>
    </RadixContextMenu.Portal>
  );
}
