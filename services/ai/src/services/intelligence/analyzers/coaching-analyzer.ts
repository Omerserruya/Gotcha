import type { ConversationStateFrame } from "@chatcenter/shared";
import type { TranscriptAnalyzer, AnalysisContext } from "./types";

/**
 * Phase 5 (Mode A QA) - heuristic coaching scorer.
 *
 * Operates on persisted CallAnalysis.frames. Identifies coaching
 * opportunities the rep could have acted on:
 *   - missing-fields that stayed missing through the whole call
 *   - sentiment trajectory (got worse over time?)
 *   - ignored coaching hints (suggestedActions across frames)
 *   - missed urgency escalation
 *
 * V1 ships heuristic-only. LLM-augmented coaching (deep transcript reading)
 * lands in a polish pass with the PostCallPromptAssembler.
 */

export interface CoachingAnalyzerInput {
  frames: ConversationStateFrame[];
}

export interface CoachingAnalyzerOutput {
  /** Normalized 0..1. Higher = better coaching adherence. */
  score: number;
  strengths: Array<{ note: string; refLiveFrameVersions: number[] }>;
  improvements: Array<{ note: string; refLiveFrameVersions: number[] }>;
  drilldowns: Array<{ topic: string; note: string }>;
  findings: Array<{
    kind: "coaching_opportunity";
    refUtteranceIds: string[];
    note: string;
  }>;
}

export class CoachingAnalyzer
  implements TranscriptAnalyzer<CoachingAnalyzerInput, CoachingAnalyzerOutput>
{
  readonly name = "coaching";
  readonly mode = "qa" as const;
  readonly cadence = "onFinal" as const;

  async analyze(
    _ctx: AnalysisContext,
    input: CoachingAnalyzerInput,
  ): Promise<CoachingAnalyzerOutput> {
    const { frames } = input;
    const strengths: CoachingAnalyzerOutput["strengths"] = [];
    const improvements: CoachingAnalyzerOutput["improvements"] = [];
    const drilldowns: CoachingAnalyzerOutput["drilldowns"] = [];
    const findings: CoachingAnalyzerOutput["findings"] = [];

    // 1. Persistent-missing-fields: any field flagged required on the LAST
    //    frame that was also missing on the first frame indicates the rep
    //    never elicited it.
    const lastFrame = frames[frames.length - 1];
    const firstFrame = frames[0];
    if (lastFrame && firstFrame) {
      const missingAtEnd = new Set(
        lastFrame.missingFields.filter((f) => f.required).map((f) => f.field),
      );
      const missingAtStart = new Set(
        firstFrame.missingFields.filter((f) => f.required).map((f) => f.field),
      );
      const persistent = [...missingAtEnd].filter((f) => missingAtStart.has(f));
      for (const field of persistent) {
        improvements.push({
          note: `Required field "${field}" was never collected.`,
          refLiveFrameVersions: [firstFrame.version, lastFrame.version],
        });
        findings.push({
          kind: "coaching_opportunity",
          refUtteranceIds: [],
          note: `Missing field "${field}" persisted through the call.`,
        });
      }
    }

    // 2. Sentiment trajectory - split frames in half, compare averages.
    const sentimentValues = frames
      .map((f) => f.sentiment?.customer)
      .filter((v): v is number => typeof v === "number");
    if (sentimentValues.length >= 4) {
      const mid = Math.floor(sentimentValues.length / 2);
      const avgEarly = avg(sentimentValues.slice(0, mid));
      const avgLate = avg(sentimentValues.slice(mid));
      if (avgLate < avgEarly - 0.25) {
        improvements.push({
          note: `Customer sentiment declined from ${avgEarly.toFixed(2)} to ${avgLate.toFixed(2)} over the call.`,
          refLiveFrameVersions: [
            frames[0].version,
            frames[frames.length - 1].version,
          ],
        });
        drilldowns.push({
          topic: "sentiment_decline",
          note: "Late-call sentiment dropped >0.25 below the first half. Review objection-handling stage.",
        });
      } else if (avgLate > avgEarly + 0.25) {
        strengths.push({
          note: `Sentiment improved from ${avgEarly.toFixed(2)} to ${avgLate.toFixed(2)}.`,
          refLiveFrameVersions: [
            frames[0].version,
            frames[frames.length - 1].version,
          ],
        });
      }
    }

    // 3. Ignored coaching hints - suggestedActions emitted across frames
    //    but no follow-up "tag/note/action" tool was proposed afterwards
    //    is a heuristic signal.
    const totalSuggestions = frames.reduce(
      (n, f) => n + f.suggestedActions.length,
      0,
    );
    const totalProposals = frames.reduce(
      (n, f) => n + f.proposedTools.length,
      0,
    );
    if (totalSuggestions > 5 && totalProposals === 0) {
      improvements.push({
        note: `${totalSuggestions} coaching hints were emitted but no tool actions were proposed.`,
        refLiveFrameVersions: frames.map((f) => f.version),
      });
    }

    // 4. Score: 1.0 minus penalty per improvement (capped at 0.5 floor).
    const penaltyPerImprovement = 0.15;
    const rawScore = 1 - improvements.length * penaltyPerImprovement;
    const score = Math.max(0.5, Math.min(1, rawScore));

    return { score, strengths, improvements, drilldowns, findings };
  }
}

function avg(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
