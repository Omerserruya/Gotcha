/**
 * When the inbox re-reads itself after a realtime event - decided here, with
 * the browser passed in, so every rule has a test.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THE LAST EVENT IS ALWAYS READ
 * ════════════════════════════════════════════════════════════════════════════
 * An event makes the screen `dirty`. A re-read clears it and opens a window in
 * which anything new only marks it dirty again; when the window closes, a
 * dirty screen is read once more. So a burst costs one read per window, and
 * an event that arrives at ANY moment - before a scheduled read, during one,
 * after it - is followed by a read that starts after it.
 *
 * ★ StreamLive's single timer had the same property, implicitly: an event it
 *   dropped while armed was covered because the armed read ran after it, and
 *   one after the read armed another. `dirty` says it out loud, so a hidden
 *   tab or an open menu can hold the read without losing what it owes.
 *
 * ── HELD, NOT DROPPED ──
 *   hidden  a tab nobody is looking at does not render the server's page.
 *           The screen stays dirty and is read once, when it is shown.
 *   held    something on screen was built from the rows as they were (an
 *           open menu: its items were planned from the row it was opened
 *           on). Re-checked each window; read when it closes.
 */

/** A first event waits this long for the rest of its burst (a message is three frames). */
export const GATHER_MS = 250;
/** At most one re-read per window; what arrives inside it is read when it closes. */
export const WINDOW_MS = 1_000;

export interface RefreshDeps {
  refresh(): void;
  /** The tab is hidden. */
  hidden(): boolean;
  /** A re-read now would contradict something open on screen. */
  held(): boolean;
}

export interface RefreshScheduler {
  /** Something changed: the screen is stale. */
  poke(): void;
  /** The tab was shown again. */
  shown(): void;
  /** The screen is gone: nothing more runs. */
  stop(): void;
}

export function refreshScheduler(deps: RefreshDeps): RefreshScheduler {
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const arm = (ms: number) => {
    timer = setTimeout(fire, ms);
  };

  function fire() {
    timer = null;
    // The window closed with nothing new: idle until the next event.
    if (!dirty) return;
    // Still dirty, and `shown` re-arms.
    if (deps.hidden()) return;
    if (deps.held()) {
      arm(WINDOW_MS);
      return;
    }
    dirty = false;
    deps.refresh();
    arm(WINDOW_MS);
  }

  return {
    poke() {
      if (stopped) return;
      dirty = true;
      if (timer === null && !deps.hidden()) arm(GATHER_MS);
    },
    shown() {
      if (stopped || !dirty || timer !== null) return;
      arm(GATHER_MS);
    },
    stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
