import { tabRole, type TabRole } from './decide';

/**
 * Which of the open v2 tabs speaks for an incoming message.
 *
 * Every tab opens its own socket and hears every message in its workspace, so
 * without this N tabs chime N times. The rule (`tabRole`):
 *
 *   - a visible, focused tab chimes for itself, and no other tab does;
 *   - otherwise exactly one tab - the leader - chimes and shows the popup.
 *
 * ── THE LEADER IS A WEB LOCK ──
 * Each tab asks for one exclusive lock and holds it until it goes. The browser
 * grants it to one tab and queues the rest; when the holder closes, crashes or
 * navigates away, the browser releases it and the next tab in the queue
 * becomes the leader. No heartbeat, no timeout, no tab deciding another is
 * dead.
 *
 * ── WHO IS FOCUSED IS A BROADCAST ──
 * Tabs announce their own focus on a BroadcastChannel when it changes, answer
 * a newcomer's hello, and say goodbye on `pagehide`. A tab hidden into the
 * back/forward cache said goodbye; it announces itself again on `pageshow`.
 *
 * Both are per workspace: a tab of another workspace hears other messages.
 *
 * Without Web Locks (very old browsers) every tab leads, so nothing is lost -
 * at worst a chime per tab, the behaviour without any of this. Without
 * BroadcastChannel no tab knows of another's focus, so the leader chimes
 * beside the focused tab's own chime; the burst rule still holds per tab.
 */

type Announcement =
  | { readonly kind: 'focus'; readonly tab: string; readonly focused: boolean }
  | { readonly kind: 'hello'; readonly tab: string }
  | { readonly kind: 'bye'; readonly tab: string };

export interface ElectionEnvironment {
  readonly window: Window;
  readonly document: Document;
  readonly locks: LockManager | undefined;
  readonly makeChannel: ((name: string) => BroadcastChannel) | undefined;
}

function browserEnvironment(): ElectionEnvironment {
  return {
    window,
    document,
    locks: typeof navigator !== 'undefined' ? navigator.locks : undefined,
    makeChannel:
      typeof BroadcastChannel === 'undefined' ? undefined : (name) => new BroadcastChannel(name),
  };
}

export class AlertElection {
  private readonly tab = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  private leader = false;
  private readonly focusedElsewhere = new Set<string>();
  private channel: BroadcastChannel | null = null;
  private readonly abort = new AbortController();
  private release: (() => void) | null = null;
  private readonly cleanups: (() => void)[] = [];

  constructor(
    private readonly workspace: string,
    private readonly env: ElectionEnvironment = browserEnvironment(),
  ) {}

  start(): void {
    const name = `gotcha:inbound-alerts:${this.workspace}`;
    this.campaign(name);
    this.listen(name);
  }

  stop(): void {
    this.abort.abort();
    this.release?.();
    this.release = null;
    this.leader = false;
    this.post({ kind: 'bye', tab: this.tab });
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.channel?.close();
    this.channel = null;
  }

  /** Visible and focused, now. */
  selfFocused(): boolean {
    const { document } = this.env;
    return document.visibilityState === 'visible' && document.hasFocus();
  }

  role(): TabRole {
    return tabRole({
      selfFocused: this.selfFocused(),
      otherFocused: this.focusedElsewhere.size > 0,
      leader: this.leader,
    });
  }

  private campaign(name: string): void {
    const { locks } = this.env;
    if (!locks) {
      this.leader = true;
      return;
    }
    locks
      .request(name, { mode: 'exclusive', signal: this.abort.signal }, () => {
        this.leader = true;
        // Held until this tab goes, or `stop()` lets it go.
        return new Promise<void>((resolve) => {
          this.release = () => {
            this.leader = false;
            resolve();
          };
        });
      })
      .catch(() => {
        // Aborted by `stop()`, or refused: this tab is simply not the leader.
      });
  }

  private listen(name: string): void {
    const { window, document, makeChannel } = this.env;
    try {
      this.channel = makeChannel ? makeChannel(name) : null;
    } catch {
      this.channel = null;
    }
    if (this.channel) {
      const heard = (event: MessageEvent<Announcement>) => this.hear(event.data);
      this.channel.addEventListener('message', heard);
    }

    const announce = () => this.post({ kind: 'focus', tab: this.tab, focused: this.selfFocused() });
    const bye = () => this.post({ kind: 'bye', tab: this.tab });
    const back = () => {
      announce();
      this.post({ kind: 'hello', tab: this.tab });
    };
    window.addEventListener('focus', announce);
    window.addEventListener('blur', announce);
    document.addEventListener('visibilitychange', announce);
    window.addEventListener('pagehide', bye);
    window.addEventListener('pageshow', back);
    this.cleanups.push(() => {
      window.removeEventListener('focus', announce);
      window.removeEventListener('blur', announce);
      document.removeEventListener('visibilitychange', announce);
      window.removeEventListener('pagehide', bye);
      window.removeEventListener('pageshow', back);
    });

    // Ask the tabs already open where focus is, and say where it is here.
    this.post({ kind: 'hello', tab: this.tab });
    announce();
  }

  private hear(message: Announcement | null | undefined): void {
    if (!message || typeof message !== 'object' || message.tab === this.tab) return;
    if (message.kind === 'hello') {
      this.post({ kind: 'focus', tab: this.tab, focused: this.selfFocused() });
      return;
    }
    if (message.kind === 'bye' || (message.kind === 'focus' && !message.focused)) {
      this.focusedElsewhere.delete(message.tab);
      return;
    }
    if (message.kind === 'focus') this.focusedElsewhere.add(message.tab);
  }

  private post(message: Announcement): void {
    try {
      this.channel?.postMessage(message);
    } catch {
      // A closed channel: nothing to tell.
    }
  }
}
