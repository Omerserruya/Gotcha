import { aggregateAll } from "./cue-outcomes.repo";

/**
 * Per-cue weight cache, refreshed every 5 minutes (or on demand after a
 * fresh outcome is recorded). weight ∈ (0, 1) is the Laplace-smoothed
 * positive rate; CueProjector multiplies the cue's raw urgency score by
 * the weight before threshold check, so a cue type reps keep rejecting
 * gradually falls below the lane gate and stops surfacing.
 *
 * Smoothing rationale:
 *   weight = (accepts + 1) / (accepts + rejects + 0.5*ignores + 2)
 *   - Unseen cue → 0.5 (neutral) instead of biasing high or low.
 *   - "ignored" counts half-negative - gentler than an explicit reject.
 */

const CACHE_TTL_MS = 5 * 60_000;
const NEUTRAL_WEIGHT = 0.5;

class TrustWeights {
  private cache = new Map<string, number>();
  private loadedAt = 0;
  private inflight: Promise<void> | null = null;

  weightFor(kind: string, text: string): number {
    if (Date.now() - this.loadedAt > CACHE_TTL_MS) {
      // Don't await - first call after expiry returns the stale value once,
      // the refresh lands for the next caller. This keeps the hot path on
      // the live runner non-blocking.
      void this.refresh();
    }
    return this.cache.get(this.key(kind, text)) ?? NEUTRAL_WEIGHT;
  }

  /** Force a refresh - used by the cue-outcome route after a new record. */
  refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const rows = await aggregateAll();
        const next = new Map<string, number>();
        for (const r of rows) {
          const pos = r.accepts + 1;
          const neg = r.rejects + r.ignores * 0.5 + 1;
          next.set(this.key(r.cueKind, r.cueText), pos / (pos + neg));
        }
        this.cache = next;
        this.loadedAt = Date.now();
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  /** Test hook - seed weights directly, bypassing DB. */
  _setForTest(kind: string, text: string, weight: number): void {
    this.cache.set(this.key(kind, text), weight);
    this.loadedAt = Date.now();
  }

  /** Test hook - clear cache and reset load time. */
  _resetForTest(): void {
    this.cache.clear();
    this.loadedAt = 0;
    this.inflight = null;
  }

  private key(kind: string, text: string): string {
    return `${kind}:${text}`;
  }
}

export const trustWeights = new TrustWeights();
