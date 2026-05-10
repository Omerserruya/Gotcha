import type { ConversationStateFrame } from "@chatcenter/shared";
import type { TranscriptAnalyzer } from "./types";

export class RiskDetector
  implements TranscriptAnalyzer<ConversationStateFrame, ConversationStateFrame["risks"]>
{
  readonly name = "risks";
  readonly mode = "live" as const;
  readonly cadence = "perWindow" as const;

  async analyze(
    _ctx: unknown,
    frame: ConversationStateFrame,
  ): Promise<ConversationStateFrame["risks"]> {
    return frame.risks;
  }
}
