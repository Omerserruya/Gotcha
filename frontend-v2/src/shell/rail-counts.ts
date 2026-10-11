'use client';

import { useEffect, useSyncExternalStore } from 'react';

/**
 * Counts a page hands the rail for its own views - today the inbox's unread
 * count per view.
 *
 * ★ THE PAGE READS, THE RAIL DRAWS. The rail is in the shell, rendered once
 *   for every screen; the inbox page re-renders on every open, verb and live
 *   refresh. Reading the count where it changes and publishing it here keeps
 *   the rail's number as fresh as the list beside it, with no read of its
 *   own on screens that have no counts.
 *
 * `null` is "nobody said": the rail draws no count at all. The publisher
 * clears it when the page goes, so another screen never shows the inbox's.
 */
export type RailCounts = Readonly<Record<string, number>>;

let current: RailCounts | null = null;
const listeners = new Set<() => void>();

function set(next: RailCounts | null): void {
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The counts in force, or `null`. Server render: always `null`. */
export function useRailCounts(): RailCounts | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
}

/** Renders nothing: hands `counts` to the rail while mounted, and takes them back after. */
export function PublishRailCounts({ counts }: { readonly counts: RailCounts | null }) {
  useEffect(() => {
    set(counts);
    return () => set(null);
  }, [counts]);
  return null;
}
