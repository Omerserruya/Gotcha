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

export function ContextMenuContent({
  children,
  ...rest
}: ComponentPropsWithoutRef<typeof RadixContextMenu.Content>) {
  return (
    <RadixContextMenu.Portal>
      <RadixContextMenu.Content className={styles.surface} collisionPadding={8} {...rest}>
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
