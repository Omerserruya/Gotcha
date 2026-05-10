import type { TranscriptUtterance } from "@chatcenter/shared";
import type { TranscriptSource } from "./transcript-source";

/**
 * Minimal contract for a Whisper-style recording transcriber.
 *
 * Phase 1 ships this interface so RecordingTranscriber can be defined and
 * type-checked. Phase 6 will provide the concrete implementation backed by
 * OpenAI Whisper (or equivalent) and wire it into the post-call worker.
 */
export interface WhisperClient {
  transcribe(
    recordingUrl: string,
    opts?: { diarize?: boolean },
  ): Promise<TranscribedSegment[]>;
}

export interface TranscribedSegment {
  /** Diarization label. "unknown" when the provider can't attribute a speaker. */
  speaker: "agent" | "customer" | "unknown";
  text: string;
  startMs: number;
  endMs: number;
  confidence?: number;
}

/**
 * Async TranscriptSource backed by a recording URL and a Whisper-style client.
 *
 * Phase 1 status: defined but NOT YET INSTANTIATED. The WhisperClient impl
 * lands in Phase 6 alongside the post-call:transcribe queue worker.
 */
export class RecordingTranscriber implements TranscriptSource {
  readonly mode = "async" as const;
  readonly isBounded = true;

  private cache?: TranscriptUtterance[];

  constructor(
    public readonly conversationId: string,
    private readonly recordingUrl: string,
    private readonly whisper: WhisperClient,
  ) {}

  async *stream(): AsyncIterable<TranscriptUtterance> {
    const all = await this.snapshot();
    for (const u of all) {
      yield u;
    }
  }

  async snapshot(): Promise<TranscriptUtterance[]> {
    if (!this.cache) {
      const segs = await this.whisper.transcribe(this.recordingUrl, {
        diarize: true,
      });
      this.cache = segs.map((s, i) => ({
        id: `${this.recordingUrl}:${i}`,
        conversationId: this.conversationId,
        source: s.speaker === "unknown" ? "system" : s.speaker,
        text: s.text,
        isFinal: true,
        startMs: s.startMs,
        endMs: s.endMs,
        confidence: s.confidence,
      }));
    }
    return this.cache;
  }

  async close(): Promise<void> {
    /* nothing to release */
  }
}
