import { getRedis, type TranscriptUtterance } from "@chatcenter/shared";

/**
 * Two-tier conversation memory backing the live analysis runner.
 *
 *   Tier A - verbatim sliding window of the most recent utterances.
 *            Drives Intent / Sentiment / Risk / Missing-field extraction.
 *
 *   Tier B - rolling 200-token summary of everything BEFORE Tier A.
 *            Updated by the side summarizer on a slower cadence (Phase 3
 *            ships the storage; the summarizer cadence runs every 30s in
 *            the runner).
 *
 * Storage: Redis keys `mem:{conversationId}:{tierA|tierB}` with TTL refresh
 * on every write. On cache miss the runner re-hydrates from
 * `CallAnalysis.frames` (the durable mirror written by Phase 3 persistence).
 */

const TTL_SECONDS = 6 * 60 * 60; // 6h
const DEFAULT_TIER_A_MAX = 40; // utterances

const tierAKey = (id: string) => `mem:${id}:tierA`;
const tierBKey = (id: string) => `mem:${id}:tierB`;

export interface ConversationMemorySnapshot {
  conversationId: string;
  tierA: TranscriptUtterance[];
  tierBSummary: string;
}

export class ConversationMemory {
  private tierA: TranscriptUtterance[] = [];
  private tierBSummary = "";
  private dirty = false;

  private constructor(
    public readonly conversationId: string,
    private readonly tierAMax: number = DEFAULT_TIER_A_MAX,
  ) {}

  /**
   * Hydrate from Redis. Empty if no prior state.
   */
  static async load(
    conversationId: string,
    opts?: { tierAMax?: number },
  ): Promise<ConversationMemory> {
    const m = new ConversationMemory(conversationId, opts?.tierAMax);
    try {
      const redis = getRedis() as any;
      const [a, b] = await Promise.all([
        redis.get(tierAKey(conversationId)),
        redis.get(tierBKey(conversationId)),
      ]);
      if (typeof a === "string" && a.length > 0) {
        try {
          const parsed = JSON.parse(a);
          if (Array.isArray(parsed)) m.tierA = parsed as TranscriptUtterance[];
        } catch {
          /* ignore corrupt entry */
        }
      }
      if (typeof b === "string") m.tierBSummary = b;
    } catch {
      /* fail open - empty memory */
    }
    return m;
  }

  append(u: TranscriptUtterance): void {
    this.tierA.push(u);
    if (this.tierA.length > this.tierAMax) {
      this.tierA = this.tierA.slice(-this.tierAMax);
    }
    this.dirty = true;
  }

  /** Last N utterances (defaults to full window). */
  tierAWindow(n?: number): TranscriptUtterance[] {
    if (n === undefined || n >= this.tierA.length) return [...this.tierA];
    return this.tierA.slice(-n);
  }

  tierB(): string {
    return this.tierBSummary;
  }

  setTierBSummary(s: string): void {
    this.tierBSummary = s;
    this.dirty = true;
  }

  snapshot(): ConversationMemorySnapshot {
    return {
      conversationId: this.conversationId,
      tierA: [...this.tierA],
      tierBSummary: this.tierBSummary,
    };
  }

  /**
   * Persist Tier A and Tier B to Redis with refreshed TTL.
   * Skipped silently if Redis is unavailable - the durable CallAnalysis
   * mirror is the source of truth on cache miss.
   */
  async flush(): Promise<void> {
    if (!this.dirty) return;
    try {
      const redis = getRedis() as any;
      const aJson = JSON.stringify(this.tierA);
      await Promise.all([
        redis.set(tierAKey(this.conversationId), aJson, "EX", TTL_SECONDS),
        redis.set(
          tierBKey(this.conversationId),
          this.tierBSummary,
          "EX",
          TTL_SECONDS,
        ),
      ]);
      this.dirty = false;
    } catch {
      /* swallow - caller already proceeded */
    }
  }
}
