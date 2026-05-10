import type { ConversationStateFrame } from "@chatcenter/shared";
import type { TranscriptAnalyzer } from "./types";

export class SentimentTracker
  implements TranscriptAnalyzer<ConversationStateFrame, ConversationStateFrame["sentiment"]>
{
  readonly name = "sentiment";
  readonly mode = "live" as const;
  readonly cadence = "debounced" as const;

  async analyze(
    _ctx: unknown,
    frame: ConversationStateFrame,
  ): Promise<ConversationStateFrame["sentiment"]> {
    return frame.sentiment;
  }
}
