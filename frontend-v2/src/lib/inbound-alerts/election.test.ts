import { afterEach, describe, expect, it, vi } from 'vitest';

import { AlertElection, type ElectionEnvironment } from './election';

/**
 * The election with the browser's two primitives faked faithfully enough to
 * hold a real lock queue and a real broadcast between "tabs":
 *
 *   - one lock per name, granted to the first requester; the rest queue, and
 *     the next is granted when the holder's promise settles;
 *   - a channel per name that delivers to every OTHER member, as
 *     BroadcastChannel does (never to the sender).
 */
function fakeBrowser() {
  const holders = new Map<string, boolean>();
  const queues = new Map<string, (() => void)[]>();
  const locks = {
    request: (
      name: string,
      options: { signal?: AbortSignal },
      callback: () => Promise<void>,
    ): Promise<void> =>
      new Promise((resolve, reject) => {
        const grant = () => {
          holders.set(name, true);
          void callback().then(() => {
            holders.set(name, false);
            const next = queues.get(name)?.shift();
            next?.();
            resolve();
          });
        };
        if (!holders.get(name)) {
          grant();
          return;
        }
        const queue = queues.get(name) ?? [];
        queue.push(grant);
        queues.set(name, queue);
        options.signal?.addEventListener('abort', () => {
          queues.set(
            name,
            (queues.get(name) ?? []).filter((g) => g !== grant),
          );
          reject(new DOMException('aborted', 'AbortError'));
        });
      }),
  } as unknown as LockManager;

  const members = new Map<string, Set<FakeChannel>>();
  class FakeChannel {
    private readonly listeners = new Set<(event: MessageEvent) => void>();
    constructor(private readonly name: string) {
      const set = members.get(name) ?? new Set();
      set.add(this);
      members.set(name, set);
    }
    addEventListener(_type: 'message', listener: (event: MessageEvent) => void) {
      this.listeners.add(listener);
    }
    postMessage(data: unknown) {
      for (const other of members.get(this.name) ?? []) {
        if (other !== this) other.deliver(data);
      }
    }
    deliver(data: unknown) {
      for (const listener of this.listeners) listener({ data } as MessageEvent);
    }
    close() {
      members.get(this.name)?.delete(this);
    }
  }

  /** One tab: its own window and document, sharing the locks and channels. */
  function tab({ withLocks = true }: { withLocks?: boolean } = {}) {
    const state = { visible: false, focused: false };
    const win = new EventTarget() as unknown as Window;
    // A getter, not Object.assign: that would copy today's value once.
    const doc = Object.defineProperties(new EventTarget(), {
      visibilityState: { get: () => (state.visible ? 'visible' : 'hidden') },
      hasFocus: { value: () => state.focused },
    }) as unknown as Document;
    const env: ElectionEnvironment = {
      window: win,
      document: doc,
      locks: withLocks ? locks : undefined,
      makeChannel: (name) => new FakeChannel(name) as unknown as BroadcastChannel,
    };
    const election = new AlertElection('t1', env);
    return {
      election,
      focus() {
        state.visible = true;
        state.focused = true;
        win.dispatchEvent(new Event('focus'));
      },
      blur() {
        state.focused = false;
        win.dispatchEvent(new Event('blur'));
      },
      /** Hidden, while the window may still report focus (a minimised window on some platforms). */
      hide() {
        state.visible = false;
        doc.dispatchEvent(new Event('visibilitychange'));
      },
    };
  }

  return { tab };
}

/** Lets the lock's promise chain run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const started: AlertElection[] = [];
afterEach(() => {
  for (const election of started.splice(0)) election.stop();
});

describe('★ which tab speaks', () => {
  it('★ the first tab leads; the second does not', async () => {
    const browser = fakeBrowser();
    const a = browser.tab();
    const b = browser.tab();
    a.election.start();
    b.election.start();
    started.push(a.election, b.election);
    await settle();
    expect(a.election.role()).toBe('leader');
    expect(b.election.role()).toBe('quiet');
  });

  it('★ a focused tab speaks for itself, and the leader keeps out', async () => {
    const browser = fakeBrowser();
    const a = browser.tab();
    const b = browser.tab();
    a.election.start();
    b.election.start();
    started.push(a.election, b.election);
    await settle();
    b.focus();
    expect(b.election.role()).toBe('focused');
    expect(a.election.role()).toBe('quiet');
    // Focus leaves v2 altogether (another app): the leader speaks again.
    b.blur();
    expect(a.election.role()).toBe('leader');
  });

  it('★ the leader closing hands over to the next tab', async () => {
    const browser = fakeBrowser();
    const a = browser.tab();
    const b = browser.tab();
    a.election.start();
    b.election.start();
    started.push(b.election);
    await settle();
    expect(b.election.role()).toBe('quiet');
    a.election.stop();
    await settle();
    expect(b.election.role()).toBe('leader');
  });

  it('a focused tab that closes stops counting as focused', async () => {
    const browser = fakeBrowser();
    const a = browser.tab();
    const b = browser.tab();
    a.election.start();
    b.election.start();
    started.push(a.election);
    await settle();
    b.focus();
    expect(a.election.role()).toBe('quiet');
    b.election.stop();
    expect(a.election.role()).toBe('leader');
  });

  it('a newcomer learns that a tab already open is focused', async () => {
    const browser = fakeBrowser();
    const a = browser.tab();
    a.election.start();
    started.push(a.election);
    a.focus();
    // No Web Locks for the newcomer: it leads by itself, so only what it hears keeps it quiet.
    const b = browser.tab({ withLocks: false });
    b.election.start();
    started.push(b.election);
    await settle();
    expect(b.election.role()).toBe('quiet');
    a.blur();
    expect(b.election.role()).toBe('leader');
  });

  it('a hidden tab is not focused, whatever the window says', async () => {
    const browser = fakeBrowser();
    const a = browser.tab();
    a.election.start();
    started.push(a.election);
    await settle();
    a.focus();
    a.hide();
    expect(a.election.role()).toBe('leader');
  });

  it('without Web Locks every tab leads - nothing is lost', () => {
    const election = new AlertElection('t1', {
      window: new EventTarget() as unknown as Window,
      document: Object.assign(new EventTarget(), {
        visibilityState: 'hidden',
        hasFocus: () => false,
      }) as unknown as Document,
      locks: undefined,
      makeChannel: undefined,
    });
    election.start();
    started.push(election);
    expect(election.role()).toBe('leader');
  });

  it('the lock is per workspace', async () => {
    const request = vi.fn(() => new Promise<void>(() => {}));
    const election = new AlertElection('tenant-9', {
      window: new EventTarget() as unknown as Window,
      document: Object.assign(new EventTarget(), {
        visibilityState: 'hidden',
        hasFocus: () => false,
      }) as unknown as Document,
      locks: { request } as unknown as LockManager,
      makeChannel: undefined,
    });
    election.start();
    started.push(election);
    expect(request).toHaveBeenCalledWith(
      'gotcha:inbound-alerts:tenant-9',
      expect.objectContaining({ mode: 'exclusive' }),
      expect.any(Function),
    );
  });
});
