import type { ConversationStateFrame } from "@chatcenter/shared";
import type { TranscriptAnalyzer, AnalysisContext } from "./types";

/**
 * Phase 5 (Mode A QA) — heuristic playbook-compliance scorer.
 *
 * Operates on the persisted CallAnalysis.frames array, NOT on raw transcript
 * — this is the architectural reason Mode A is cheap (no re-summarization,
 * no re-intent classification). The Phase 3 LiveAnalysisRunner already paid
 * for those during the call.
 *
 * V1 rubric (per migration §16): heuristic-only.
 *   - stage diversity: how many distinct stages did the call traverse?
 *   - linear progression: were transitions forward (greeting → discovery →
 *     ... → close), or did the call regress?
 *   - dwell time: did the call spend reasonable time per stage?
 *
 * A future polish pass can add an LLM-augmented rubric (PostCallPromptAssembler
 * + structured output) that looks at the actual transcript. The contract here
 * stays stable — analyzers always return `{score, findings, ...}`.
 */

export interface PlaybookComplianceInput {
  frames: ConversationStateFrame[];
}

export interface PlaybookComplianceOutput {
  /** Normalized 0..1. */
  score: number;
  stagesCovered: string[];
  stagesMissed: string[];
  deviations: Array<{
    kind: "regression" | "missing_stage" | "stale";
    note: string;
    refLiveFrameVersions: number[];
  }>;
  findings: Array<{
    kind: "compliance_miss";
    refUtteranceIds: string[];
    note: string;
  }>;
}

/**
 * Stage ordering used by V1. Tenants can override via CallPlaybook + stages
 * once the playbook authoring UI ships (post-Phase 5). Until then this
 * canonical sequence is the rubric.
 */
const CANONICAL_STAGES = [
  "greeting",
  "discovery",
  "qualification",
  "demo",
  "objection",
  "close",
  "wrap_up",
] as const;

export class PlaybookCompliance
  implements TranscriptAnalyzer<PlaybookComplianceInput, PlaybookComplianceOutput>
{
  readonly name = "playbook_compliance";
  readonly mode = "qa" as const;
  readonly cadence = "onFinal" as const;

  async analyze(
    _ctx: AnalysisContext,
    input: PlaybookComplianceInput,
  ): Promise<PlaybookComplianceOutput> {
    const { frames } = input;

    // 1. Distinct stages observed across the call.
    const stagesCovered: string[] = [];
    const seen = new Set<string>();
    for (const f of frames) {
      const sid = f.stage?.id;
      if (sid && !seen.has(sid)) {
        seen.add(sid);
        stagesCovered.push(sid);
      }
    }

    // 2. Missed stages (canonical order, not yet covered).
    const stagesMissed = CANONICAL_STAGES.filter(
      (s) => !seen.has(s),
    ) as string[];

    // 3. Deviation: regression detection (a known stage repeats AFTER a
    //    later stage in canonical order — sign of confusion or drift).
    const canonRank = new Map(CANONICAL_STAGES.map((s, i) => [s, i] as const));
    let lastSeenRank = -1;
    const deviations: PlaybookComplianceOutput["deviations"] = [];
    for (const f of frames) {
      const sid = f.stage?.id;
      if (!sid) continue;
      const rank = canonRank.get(sid as (typeof CANONICAL_STAGES)[number]);
      if (rank === undefined) continue;
      if (rank < lastSeenRank) {
        deviations.push({
          kind: "regression",
          note: `Stage ${sid} entered after a later stage`,
          refLiveFrameVersions: [f.version],
        });
      }
      lastSeenRank = Math.max(lastSeenRank, rank);
    }

    // 4. Score: stage coverage weight (60%) + linear progression (40%).
    //    Canonical 7 stages — coverage is min(covered, 7) / 7.
    const coverage = Math.min(stagesCovered.length, CANONICAL_STAGES.length) /
      CANONICAL_STAGES.length;
    const linearity =
      deviations.length === 0
        ? 1
        : Math.max(0, 1 - deviations.length / Math.max(1, frames.length));
    const score = clamp01(0.6 * coverage + 0.4 * linearity);

    // 5. Surface deviations as findings the QA UI renders inline.
    const findings: PlaybookComplianceOutput["findings"] = deviations.map(
      (d) => ({
        kind: "compliance_miss" as const,
        // Mode A QA refers to the FRAME, not raw utterances; the QA UI links
        // back via refLiveFrameVersions. Keep refUtteranceIds empty here.
        refUtteranceIds: [],
        note: d.note,
      }),
    );

    return { score, stagesCovered, stagesMissed, deviations, findings };
  }
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
