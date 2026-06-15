import type { ConversationStateFrame } from "@chatcenter/shared";
import type { TranscriptAnalyzer } from "./types";

/**
 * Selects the intent slice from a unified ConversationStateFrame.
 *
 * Phase 3 ships the analyzers as thin selectors: the LiveAnalysisRunner
 * makes ONE LLM call returning the full frame, then the runner emits
 * granular events. The analyzer files exist so Phase 5 (QA replay) and
 * Phase 6 (async processing) can compose them differently - e.g. QA may
 * want to recompute intent from raw frames while reusing the contract.
 *
 * For now, `analyze` is a pure projection of the frame.
 */
export class IntentExtractor
  implements TranscriptAnalyzer<ConversationStateFrame, ConversationStateFrame["intent"]>
{
  readonly name = "intent";
  readonly mode = "live" as const;
  readonly cadence = "debounced" as const;

  async analyze(
    _ctx: unknown,
    frame: ConversationStateFrame,
  ): Promise<ConversationStateFrame["intent"]> {
    return frame.intent;
  }
}
