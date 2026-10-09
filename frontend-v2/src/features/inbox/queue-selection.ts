import { useSyncExternalStore } from 'react';

/**
 * The conversations picked with shift-click - 02's "Shift-click to pick
 * several", which the queue menu then acts on.
 *
 * A module-level store, like the pending click: the rows and the menu sit in
 * a server-rendered list with no client parent in common.
 */
let selected: readonly string[] = [];
const listeners = new Set<() => void>();

function publish(next: readonly string[]) {
  selected = next;
  for (const listener of listeners) listener();
}

export function toggleSelected(id: string): void {
  publish(selected.includes(id) ? selected.filter((it) => it !== id) : [...selected, id]);
}

export function clearSelected(): void {
  if (selected.length > 0) publish([]);
}

export function currentSelection(): readonly string[] {
  return selected;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSelection(): readonly string[] {
  return useSyncExternalStore(
    subscribe,
    () => selected,
    () => [],
  );
}
