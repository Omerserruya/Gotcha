import type { ConversationStateFrame } from "@chatcenter/shared";
import type { TranscriptAnalyzer } from "./types";

export class StageClassifier
  implements TranscriptAnalyzer<ConversationStateFrame, ConversationStateFrame["stage"]>
{
  readonly name = "stage";
  readonly mode = "live" as const;
  readonly cadence = "debounced" as const;

  async analyze(
    _ctx: unknown,
    frame: ConversationStateFrame,
  ): Promise<ConversationStateFrame["stage"]> {
    return frame.stage;
  }
}
