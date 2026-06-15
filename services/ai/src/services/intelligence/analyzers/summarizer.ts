import type { ConversationStateFrame } from "@chatcenter/shared";
import type { TranscriptAnalyzer } from "./types";

/**
 * Summarizer thin wrapper.
 *
 * The main-turn frame leaves `summary` null in Phase 3 - the rolling
 * summary is written by a side path (Tier B updater) on a slower cadence.
 * Phase 5/6 may run a finalizer summarizer that DOES populate `summary`
 * with kind="final"; this analyzer's contract works for both.
 */
export class Summarizer
  implements TranscriptAnalyzer<ConversationStateFrame, ConversationStateFrame["summary"]>
{
  readonly name = "summary";
  readonly mode = "live" as const;
  readonly cadence = "perWindow" as const;

  async analyze(
    _ctx: unknown,
    frame: ConversationStateFrame,
  ): Promise<ConversationStateFrame["summary"]> {
    return frame.summary;
  }
}
