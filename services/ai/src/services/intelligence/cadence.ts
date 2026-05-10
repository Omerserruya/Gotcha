import type { TranscriptUtterance } from "@chatcenter/shared";
import type { ConversationMemory } from "./memory";

/**
 * Cadence policy decides WHEN the runner fires the main-turn LLM call.
 *
 * One implementation lives here for live mode (LiveCadence). Mode A QA and
 * Mode B async use their own cadence policies that land in Phase 5/6.
 * Analyzers themselves never branch on `mode` — that's the cadence's job
 * (anti-duplication rule #7).
 */
export interface AnalysisCadence {
  /**
   * Called after each new utterance is appended to memory. Returns true if
   * the runner should run a turn now.
   */
  shouldFire(memory: ConversationMemory, latest: TranscriptUtterance): boolean;
}

/**
 * Live cadence: debounced, customer-final-driven.
 *
 * Architecture spec (§5):
 *   - Intent/Sentiment/Risk run every 1500ms on the trailing window iff
 *     there are >=2 new utterances since last fire.
 *
 * Implementation: this minimal cadence fires when EITHER of:
 *   - The latest utterance is a customer-final, AND >=1500ms have passed
 *     since the last fire.
 *   - Two or more utterances have been appended since the last fire AND
 *     the latest is final, regardless of timing.
 *
 * That keeps the runner responsive on the first turn (single utterance,
 * no time pressure) but throttled afterward.
 */
export class LiveCadence implements AnalysisCadence {
  private lastFireMs = 0;
  private utterancesSinceLast = 0;
  private readonly debounceMs: number;
  private readonly minUtterancesForBurst: number;

  constructor(opts?: { debounceMs?: number; minUtterancesForBurst?: number }) {
    this.debounceMs = opts?.debounceMs ?? 1500;
    this.minUtterancesForBurst = opts?.minUtterancesForBurst ?? 2;
  }

  shouldFire(_memory: ConversationMemory, latest: TranscriptUtterance): boolean {
    this.utterancesSinceLast += 1;

    // Only customer-finals trigger a turn. Partials and agent utterances
    // append to memory but don't drive analysis.
    if (latest.source !== "customer" || !latest.isFinal) return false;

    const now = Date.now();
    const sinceLast = now - this.lastFireMs;
    const debounced = sinceLast >= this.debounceMs;
    const burst = this.utterancesSinceLast >= this.minUtterancesForBurst;

    if (debounced || burst) {
      this.lastFireMs = now;
      this.utterancesSinceLast = 0;
      return true;
    }
    return false;
  }
}
