import type { ConversationStateFrame } from "@chatcenter/shared";
import type { TranscriptAnalyzer } from "./types";

export class MissingFieldExtractor
  implements
    TranscriptAnalyzer<ConversationStateFrame, ConversationStateFrame["missingFields"]>
{
  readonly name = "missing_fields";
  readonly mode = "live" as const;
  readonly cadence = "debounced" as const;

  async analyze(
    _ctx: unknown,
    frame: ConversationStateFrame,
  ): Promise<ConversationStateFrame["missingFields"]> {
    return frame.missingFields;
  }
}
