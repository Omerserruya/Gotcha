import type { TranscriptUtterance } from "@chatcenter/shared";

/**
 * Generic transcript source. The single shape every analysis path (live, QA
 * replay, async) consumes.
 *
 * Three implementations live alongside this file:
 *   - LiveStreamingSource     - bridges voice-copilot bus events
 *   - UploadedTranscriptSource - pasted/uploaded transcript text
 *   - RecordingTranscriber    - Whisper batch over a recording URL
 *
 * The runner does not know which it has. That's how live and async share
 * one analysis stack instead of two.
 */
export interface TranscriptSource {
  readonly conversationId: string;
  readonly mode: "live" | "qa" | "async";

  /** Backpressure-safe stream of finalized + partial utterances. */
  stream(): AsyncIterable<TranscriptUtterance>;

  /**
   * Snapshot of all utterances seen so far. For bounded sources (uploaded,
   * recorded) this is the full transcript; for live, the current Tier A
   * window plus anything still queued.
   */
  snapshot(): Promise<TranscriptUtterance[]>;

  /** Live sources never end; batch sources do. Drives runner cadence. */
  readonly isBounded: boolean;

  /** Releases any subscriptions or buffers. Idempotent. */
  close(): Promise<void>;
}
