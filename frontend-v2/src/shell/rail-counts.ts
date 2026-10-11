'use client';

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';

import { isApiError } from '@/api/client/api-error';
import { browserApi } from '@/api/client/browser-api';
import { parseViewTotals, unreadCountsSchema } from '@/api/contracts/inbox';
import { inboxEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';
import { useRealtimeEvent } from '@/realtime/realtime-provider';

/**
 * Counts a page hands the rail for its own views - today the inbox's size
 * count per view, and how many conversations each view holds.
 *
 * ★★ ONE READ ON LOAD, THEN ONE PER BURST - OWNED HERE, NOT BY THE PAGE.
 *   The inbox page re-renders on every open, verb, mark-read and live
 *   refresh, and the counts used to be read in that render: one page load
 *   with `?c=` read `/unread-counts` four times in three seconds (gateway,
 *   2026-10-11). `RailUnreadCounts` reads every view in ONE call when the
 *   inbox mounts, then once more a second after the events that can change
 *   a count (a message, a conversation updated or closed - which includes
 *   this person's own read/unread frame), however many arrive in that
 *   second. A page refresh no longer reads them at all.
 *
 * `null` is "nobody said": the rail draws no count at all. The publisher
 * clears it when the page goes, so another screen never shows the inbox's.
 *
 * Both numbers come from the same answer, so they are published together and
 * cleared: a view absent from `totals` (a backend that does not send them
 * yet) draws no total. Unread is not the rail's - it is the list's, on each row.
 */
export type ViewCounts = Readonly<Partial<Record<string, number>>>;
/** The rail shows each view's size only - unread is the list's, on each row (Omer, 2026-10-11). */
export type RailCounts = { readonly totals: ViewCounts };

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

/** How long a burst of events is gathered before the counts are read again. */
export const RAIL_COUNTS_DEBOUNCE_MS = 1_000;

/**
 * Renders nothing: keeps the rail's size per view current
 * while the inbox is mounted. `views` are the inbox's view ids (the shell does not own
 * them); an unknown one is a 400, so the page passes its own list.
 *
 * A 404 (the endpoint not yet deployed) or any failure is no count - never a
 * 0. An answer that arrives after a newer request was sent is dropped, so a
 * slow early read cannot overwrite a fresh one.
 */
export function RailUnreadCounts({ views }: { readonly views: readonly string[] }) {
  const query = views.join(',');
  const sequence = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const read = useCallback(async () => {
    const mine = ++sequence.current;
    try {
      const body = await browserApi.get({
        endpoint: inboxEndpoints.unreadCounts(),
        query: { views: query },
        payload: unreadCountsSchema,
      });
      if (mine !== sequence.current) return;
      const asked = query.split(',');
      set({ totals: parseViewTotals(body, asked) });
    } catch (cause) {
      if (mine !== sequence.current) return;
      if (isApiError(cause) && cause.status === 404) logger.debug('inbox.unread_counts_absent');
      else logger.warn('inbox.unread_counts_failed', { cause });
      set(null);
    }
  }, [query]);

  useEffect(() => {
    void read();
    return () => {
      sequence.current += 1;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      set(null);
    };
  }, [read]);

  const schedule = useCallback(() => {
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      void read();
    }, RAIL_COUNTS_DEBOUNCE_MS);
  }, [read]);

  useRealtimeEvent('message.received', schedule);
  useRealtimeEvent('conversation.updated', schedule);
  useRealtimeEvent('conversation.closed', schedule);
  return null;
}
