import {
  prisma,
  publishEvent,
  type ConversationStateFrame,
} from "@chatcenter/shared";
import { PlaybookCompliance } from "../../services/intelligence/analyzers/playbook-compliance";
import { CoachingAnalyzer } from "../../services/intelligence/analyzers/coaching-analyzer";
import {
  QAScoreStore,
  type QAScoreFinding,
} from "../../services/intelligence/persistence/qa-score-store";
import type { PostCallQAJobData } from "../../services/intelligence/queues";

/**
 * Mode A QA orchestrator.
 *
 * Loads the persisted CallAnalysis.frames stream and runs the QA analyzers
 * against it. Operates ENTIRELY on frames — no transcript, no LLM calls in
 * V1. The Phase 3 LiveAnalysisRunner already paid for the expensive analysis
 * during the call; QA reuses those frames.
 *
 * Output: a QAScore row + `qa.scored` event.
 */

const RUBRIC_VERSION_V1 = "v1";

export async function runQA(
  job: PostCallQAJobData,
): Promise<{ ok: boolean; reason?: string; qaScoreId?: string }> {
  // 1. Load CallAnalysis. QA only runs on completed live-mode analyses.
  const callAnalysis = await (prisma as any).callAnalysis.findUnique({
    where: { conversationId: job.conversationId },
  });
  if (!callAnalysis) {
    return { ok: false, reason: "call_analysis_missing" };
  }
  if (callAnalysis.tenantId !== job.tenantId) {
    return { ok: false, reason: "tenant_mismatch" };
  }
  if (callAnalysis.mode !== "live") {
    // Mode A is only for live-driven analyses. Mode B (async, Phase 6)
    // produces its own scoring pipeline. Skip silently.
    return { ok: false, reason: "not_live_mode" };
  }

  const frames = normalizeFrames(callAnalysis.frames);
  if (frames.length === 0) {
    return { ok: false, reason: "no_frames" };
  }

  // 2. Build a thin AnalysisContext. QA analyzers only read frame fields;
  //    memory/org/crm/llm aren't used in V1. Phase 6+ may inject them.
  const ctx = {
    conversationId: job.conversationId,
    tenantId: job.tenantId,
    memory: undefined,
    org: undefined,
    crm: undefined,
    llm: undefined,
    emit: () => {},
  } as any;

  // 3. Run analyzers. Both are pure functions of the frame array — safe to
  //    parallelize, but V1 sequences them for simpler error-handling.
  const playbookCompliance = new PlaybookCompliance();
  const coaching = new CoachingAnalyzer();

  const compliance = await playbookCompliance.analyze(ctx, { frames });
  const coachingResult = await coaching.analyze(ctx, { frames });

  // 4. Risk score: aggregate from frames (RiskDetector ran during live mode
  //    and emitted into each frame's `risks[]`). Mode A's risk score is the
  //    mean per-frame risk weighted by severity.
  const riskScore = aggregateRiskFromFrames(frames);

  // 5. Findings union — caps total at 25 to bound JSON size and UI load.
  const findings: QAScoreFinding[] = [
    ...compliance.findings,
    ...coachingResult.findings,
    ...riskFindingsFromFrames(frames),
  ].slice(0, 25);

  const refLiveFrameVersions = frames.map((f) => f.version);

  // 6. Persist + emit.
  const writeResult = await QAScoreStore.create({
    callAnalysisId: callAnalysis.id,
    conversationId: job.conversationId,
    rubricVersion: job.rubricVersion ?? RUBRIC_VERSION_V1,
    playbookComplianceScore: compliance.score,
    coachingScore: coachingResult.score,
    riskScore,
    findings,
    refLiveFrameVersions,
  });

  if (!writeResult) {
    return { ok: false, reason: "qa_score_write_failed" };
  }

  await publishEvent({
    event: "qa.scored",
    tenantId: job.tenantId,
    data: {
      conversationId: job.conversationId,
      callAnalysisId: callAnalysis.id,
      qaScoreId: writeResult.id,
      rubricVersion: job.rubricVersion ?? RUBRIC_VERSION_V1,
      scores: {
        playbookCompliance: compliance.score,
        coaching: coachingResult.score,
        risk: riskScore,
      },
      ts: new Date().toISOString(),
    },
  }).catch((err: any) => {
    console.warn("[post-call.qa] qa.scored publish failed:", err?.message);
  });

  return { ok: true, qaScoreId: writeResult.id };
}

// ── helpers ─────────────────────────────────────────────────────

function normalizeFrames(raw: unknown): ConversationStateFrame[] {
  if (!Array.isArray(raw)) return [];
  // Frames are stored as JSONB; trust the producer (Phase 3 LiveAnalysisRunner
  // validates with Zod before append) and avoid re-validating here for cost.
  return raw as ConversationStateFrame[];
}

const SEVERITY_WEIGHT: Record<"low" | "medium" | "high", number> = {
  low: 0.2,
  medium: 0.55,
  high: 1.0,
};

function aggregateRiskFromFrames(frames: ConversationStateFrame[]): number {
  let totalWeight = 0;
  let count = 0;
  for (const f of frames) {
    for (const r of f.risks) {
      const w = SEVERITY_WEIGHT[r.severity] ?? 0.5;
      totalWeight += w;
      count++;
    }
  }
  if (count === 0) return 0;
  // Normalize: average severity weight, clamped to [0,1].
  const avg = totalWeight / count;
  return Math.max(0, Math.min(1, avg));
}

function riskFindingsFromFrames(
  frames: ConversationStateFrame[],
): QAScoreFinding[] {
  // Surface up to 5 highest-severity risks as findings for the QA UI.
  const all = frames.flatMap((f) =>
    f.risks.map((r) => ({
      kind: "risk" as const,
      refUtteranceIds: r.evidenceUtteranceIds,
      note: `${r.kind} (${r.severity})`,
      severity: r.severity,
    })),
  );
  all.sort(
    (a, b) =>
      (SEVERITY_WEIGHT[b.severity] ?? 0) - (SEVERITY_WEIGHT[a.severity] ?? 0),
  );
  return all.slice(0, 5).map((r) => ({
    kind: r.kind,
    refUtteranceIds: r.refUtteranceIds,
    note: r.note,
  }));
}
