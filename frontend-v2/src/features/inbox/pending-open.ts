import { useSyncExternalStore } from 'react';

/**
 * The conversation a click has asked for and the server has not yet answered.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THE CLICK IS ANSWERED HERE, BEFORE THE SERVER IS
 * ════════════════════════════════════════════════════════════════════════════
 * Omer: *"I want it to feel instant."* A row is a link, so a click is a
 * navigation, and the screen did nothing until the server sent the new page.
 * The row (`QueueRowLink`) and the pane (`PendingPane`) read this instead: the
 * row is marked and the pane shows who it is the moment it is clicked, and
 * the server's render replaces both when it lands.
 *
 * A module-level store because the row and the pane are in different parts of
 * a server-rendered tree with no client parent in common.
 */
export interface PendingOpen {
  readonly id: string;
  readonly name: string | null;
  readonly channelLabel: string | null;
  /** The channel itself, for its mark beside the name - as the header draws it. */
  readonly channel?: string | null;
}

let current: PendingOpen | null = null;
const listeners = new Set<() => void>();

function publish(next: PendingOpen | null) {
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

export function markPendingOpen(next: PendingOpen): void {
  publish(next);
}

export function clearPendingOpen(): void {
  publish(null);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePendingOpen(): PendingOpen | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    // On the server nothing is pending: the click has not happened.
    () => null,
  );
}
