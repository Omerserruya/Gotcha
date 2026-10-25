/**
 * Whether the inbox's Copilot panel is open, kept per person in this browser
 * (Omer, 2026-10-25): an agent who hides it finds it hidden on the next
 * conversation and after a reload, and a colleague on the same machine does
 * not inherit their choice.
 *
 * Open unless this person closed it. A browser that refuses storage keeps the
 * choice in memory until a reload, never an error.
 */

const KEY_PREFIX = 'gotcha:inbox-copilot:';
const CHANGED_EVENT = 'gotcha:inbox-copilot-changed';
const CLOSED = 'closed';

type Store = Pick<Storage, 'getItem' | 'setItem'>;

const memory = new Map<string, boolean>();

function browserStore(): Store | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** One key per person; `null` (who it is was not read) shares one key. */
export function copilotPanelKey(userId: string | null): string {
  return `${KEY_PREFIX}${userId ?? 'anyone'}`;
}

export function readCopilotOpen(key: string, store: Store | null = browserStore()): boolean {
  try {
    if (store) return store.getItem(key) !== CLOSED;
  } catch {
    // Refused: what this tab last chose, below.
  }
  return memory.get(key) ?? true;
}

export function writeCopilotOpen(
  key: string,
  open: boolean,
  store: Store | null = browserStore(),
): void {
  memory.set(key, open);
  try {
    store?.setItem(key, open ? 'open' : CLOSED);
  } catch {
    // Kept in memory only.
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHANGED_EVENT));
}

export function subscribeCopilotPanel(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const fromOtherTab = (event: StorageEvent) => {
    if (event.key === null || event.key.startsWith(KEY_PREFIX)) onChange();
  };
  window.addEventListener('storage', fromOtherTab);
  window.addEventListener(CHANGED_EVENT, onChange);
  return () => {
    window.removeEventListener('storage', fromOtherTab);
    window.removeEventListener(CHANGED_EVENT, onChange);
  };
}
