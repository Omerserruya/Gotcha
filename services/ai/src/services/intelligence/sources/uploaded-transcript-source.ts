import type { TranscriptUtterance } from "@chatcenter/shared";
import type { TranscriptSource } from "./transcript-source";

/**
 * Async TranscriptSource for pasted or uploaded transcripts.
 *
 * The caller (Phase 6 post-call worker) pre-parses external transcript text
 * into TranscriptUtterance[] and constructs this source. The analysis runner
 * consumes it identically to a live source - no special-casing per mode.
 */
export class UploadedTranscriptSource implements TranscriptSource {
  readonly mode = "async" as const;
  readonly isBounded = true;

  constructor(
    public readonly conversationId: string,
    private readonly utterances: TranscriptUtterance[],
  ) {}

  async *stream(): AsyncIterable<TranscriptUtterance> {
    for (const u of this.utterances) {
      yield u;
    }
  }

  async snapshot(): Promise<TranscriptUtterance[]> {
    return this.utterances;
  }

  async close(): Promise<void> {
    /* nothing to release */
  }
}
