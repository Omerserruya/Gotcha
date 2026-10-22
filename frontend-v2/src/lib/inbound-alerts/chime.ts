/**
 * The chime for an incoming message: two soft sine notes, rising, about a
 * quarter of a second, made with the Web Audio API - no audio file to fetch,
 * and nothing in `public/` that would do.
 *
 * ── A BROWSER PLAYS NOTHING BEFORE THE PAGE HAS HAD A GESTURE ──
 * An AudioContext made before the person has clicked or typed starts
 * suspended (and Chrome logs a warning for making one). So the context is
 * made on the first gesture - `prime()` listens for one - and `play()` before
 * that, or while the context is still suspended, plays nothing and says so:
 * no error, no queued sound arriving late on the next click.
 */

/** Two notes, a fifth apart: A5 then E6. */
const NOTES = [
  { frequency: 880, at: 0, length: 0.12 },
  { frequency: 1318.51, at: 0.1, length: 0.15 },
] as const;

/** Peak gain. Low: a chime beside someone's music, not over it. */
export const CHIME_PEAK = 0.06;

export interface ChimeEnvironment {
  readonly window: Window;
  readonly AudioContext: (new () => AudioContext) | undefined;
}

function browserEnvironment(): ChimeEnvironment | null {
  if (typeof window === 'undefined') return null;
  const ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: new () => AudioContext }).webkitAudioContext;
  return { window, AudioContext: ctor };
}

const GESTURES = ['pointerdown', 'keydown', 'touchstart'] as const;

export class Chime {
  private context: AudioContext | null = null;
  private primed = false;

  constructor(private readonly env: ChimeEnvironment | null = browserEnvironment()) {}

  /** Make (or wake) the context on the first gesture. Idempotent. */
  prime(): void {
    const env = this.env;
    if (!env || this.primed) return;
    this.primed = true;
    const unlock = () => {
      if (!this.wake()) return;
      for (const type of GESTURES) env.window.removeEventListener(type, unlock, true);
    };
    for (const type of GESTURES) env.window.addEventListener(type, unlock, true);
  }

  /** Called from a gesture: make the context if there is none, and resume it. */
  wake(): boolean {
    const env = this.env;
    if (!env?.AudioContext) return false;
    try {
      this.context ??= new env.AudioContext();
      if (this.context.state === 'suspended') void this.context.resume().catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  /** From a click (the settings switch): wake the context, and play once it runs. */
  playFromGesture(): void {
    if (!this.wake() || !this.context) return;
    const context = this.context;
    if (context.state === 'running') {
      this.play();
      return;
    }
    void context.resume().then(
      () => this.play(),
      () => {},
    );
  }

  /** Plays the chime now. False when the browser would not: no gesture yet, or blocked. */
  play(): boolean {
    const context = this.context;
    if (!context || context.state !== 'running') {
      // Still suspended after a gesture: ask again, play nothing now.
      if (context?.state === 'suspended') void context.resume().catch(() => {});
      return false;
    }
    try {
      const start = context.currentTime + 0.01;
      for (const note of NOTES) {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(note.frequency, start + note.at);
        gain.gain.setValueAtTime(0.0001, start + note.at);
        gain.gain.exponentialRampToValueAtTime(CHIME_PEAK, start + note.at + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + note.at + note.length);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start(start + note.at);
        oscillator.stop(start + note.at + note.length + 0.02);
      }
      return true;
    } catch {
      return false;
    }
  }
}

/** The one chime of this page: the listener and the settings page share its context. */
let shared: Chime | null = null;
export function sharedChime(): Chime {
  shared ??= new Chime();
  return shared;
}
