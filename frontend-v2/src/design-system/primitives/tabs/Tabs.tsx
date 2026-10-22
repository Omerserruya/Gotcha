'use client';

import { Tabs as RadixTabs } from 'radix-ui';
import type { ComponentPropsWithoutRef } from 'react';

import styles from './Tabs.module.css';

/**
 * Tabs.
 *
 * Radix implements the WAI-ARIA tabs pattern: arrow keys move between tabs,
 * Home/End jump to the ends, and - the part that matters here - the arrow keys
 * reverse under RTL when a `DirectionProvider` is in scope. Left arrow moving
 * "back" in Hebrew means moving right, and getting that wrong makes keyboard
 * navigation feel broken to a native reader.
 */
export const Tabs = RadixTabs.Root;

export function TabsList(props: ComponentPropsWithoutRef<typeof RadixTabs.List>) {
  return <RadixTabs.List className={styles.list} {...props} />;
}

export function TabsTrigger(props: ComponentPropsWithoutRef<typeof RadixTabs.Trigger>) {
  return <RadixTabs.Trigger className={styles.trigger} {...props} />;
}

export function TabsContent(props: ComponentPropsWithoutRef<typeof RadixTabs.Content>) {
  return <RadixTabs.Content className={styles.content} {...props} />;
}
