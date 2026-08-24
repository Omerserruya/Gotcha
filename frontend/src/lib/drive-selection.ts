/**
 * What the admin has ticked in the Google Drive browser.
 *
 * Folders and files cannot be imported in the same batch: a folder source owns
 * the documents it produced and cleans them up when they leave the folder, and
 * a batch holding both is ambiguous about which source owns what. The server
 * refuses a mixed selection, so the picker never builds one - switching kind
 * replaces the selection instead of adding to it.
 *
 * Kept out of the page component so the rule can be tested on its own rather
 * than through a modal.
 */

export type DriveSelectionKind = "file" | "folder";

export interface DriveSelectionItem {
  id: string;
  kind: DriveSelectionKind;
  name: string;
  driveId?: string;
  mimeType?: string;
}

export interface DriveSelectionState {
  items: Map<string, DriveSelectionItem>;
  /** Null when nothing is selected, so the next pick is free to be either kind. */
  kind: DriveSelectionKind | null;
}

export function emptyDriveSelection(): DriveSelectionState {
  return { items: new Map(), kind: null };
}

/**
 * Tick or untick one item.
 *
 * `driveId` is carried from the browsing context rather than the item, because
 * a file listed inside a Shared Drive has to be queried with that drive's id
 * and the listing is the only place that knows it.
 */
export function toggleDriveSelection(
  state: DriveSelectionState,
  item: { id: string; name: string; mimeType: string },
  isFolder: boolean,
  driveId?: string,
): DriveSelectionState {
  const kind: DriveSelectionKind = isFolder ? "folder" : "file";

  // Untick: never changes kind semantics beyond emptying the selection.
  if (state.kind === kind && state.items.has(item.id)) {
    const items = new Map(state.items);
    items.delete(item.id);
    return { items, kind: items.size === 0 ? null : kind };
  }

  // Switching kind starts a fresh selection rather than mixing.
  const items = state.kind === null || state.kind === kind ? new Map(state.items) : new Map();
  items.set(item.id, { id: item.id, kind, name: item.name, driveId, mimeType: item.mimeType });
  return { items, kind };
}

export function driveSelectionList(state: DriveSelectionState): DriveSelectionItem[] {
  // Array.from rather than a spread: this project's tsconfig target predates
  // downlevel iteration over Map iterators.
  return Array.from(state.items.values());
}
