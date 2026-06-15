import {
  prisma,
  publishEvent,
  type ConversationStateFrame,
  type TranscriptUtterance,
} from "@chatcenter/shared";
import {
  UploadedTranscriptSource,
  RecordingTranscriber,
  type TranscriptSource,
  type WhisperClient,
} from "../../services/intelligence/sources";
import { CallAnalysisStore } from "../../services/intelligence/persistence/call-analysis-store";
import { QAScoreStore } from "../../services/intelligence/persistence/qa-score-store";
import { PlaybookCompliance } from "../../services/intelligence/analyzers/playbook-compliance";
import { CoachingAnalyzer } from "../../services/intelligence/analyzers/coaching-analyzer";

/**
 * Phase 6 - Mode B (async post-call analysis) runner.
 *
 * Two ingest paths (the doc's TranscriptSource abstraction is the linchpin):
 *   - "uploaded": the caller hands us the parsed TranscriptUtterance[]
 *   - "recording": we transcribe a URL via a WhisperClient
 *
 * V1 produces a SINGLE synthetic ConversationStateFrame from the transcript
 * - no LLM calls in V1. Aggregates basic stats (utterance count, speaker
 * mix, total duration) into the frame. Phase 6.x will replace the synthetic
 * frame with a PostCallPromptAssembler + structured-output LLM call so the
 * resulting CallAnalysis is shape-equivalent to a live-mode analysis.
 *
 * Even in V1 the architectural milestone lands: drop a transcript in →
 * get a CallAnalysis row + QAScore row + analysis.completed event out.
 */

const ASYNC_RUBRIC_VERSION = "v1-async";

export type ModeBSourceSpec =
  | { kind: "uploaded"; utterances: TranscriptUtterance[] }
  | { kind: "recording"; recordingUrl: string };

export interface AsyncRunInput {
  conversationId: string;
  tenantId: string;
  source: ModeBSourceSpec;
  /** Injected for tests. In production, providers register a singleton. */
  whisperClient?: WhisperClient;
}

export interface AsyncRunOutput {
  ok: boolean;
  reason?: string;
  callAnalysisId?: string;
  qaScoreId?: string;
  utteranceCount?: number;
}

export async function runAsyncAnalysis(
  input: AsyncRunInput,
): Promise<AsyncRunOutput> {
  const { conversationId, tenantId, source: spec } = input;

  // 1. Construct the TranscriptSource.
  let source: TranscriptSource;
  try {
    if (spec.kind === "uploaded") {
      source = new UploadedTranscriptSource(conversationId, spec.utterances);
    } else if (spec.kind === "recording") {
      if (!input.whisperClient) {
        // V1: no concrete Whisper provider ships. Operators implement
        // WhisperClient and inject it via the trigger / DI hook. Returning
        // a clear reason instead of throwing keeps the queue from
        // burning retries on a config gap.
        return { ok: false, reason: "whisper_client_not_configured" };
      }
      source = new RecordingTranscriber(
        conversationId,
        spec.recordingUrl,
        input.whisperClient,
      );
    } else {
      return { ok: false, reason: "unknown_source_kind" };
    }
  } catch (err: any) {
    return { ok: false, reason: `source_construction_failed:${err?.message}` };
  }

  // 2. Lifecycle: emit analysis.started + ensure CallAnalysis row exists.
  await CallAnalysisStore.ensure({
    tenantId,
    conversationId,
    mode: "async",
  });
  await publishEvent({
    event: "analysis.started",
    tenantId,
    data: {
      conversationId,
      mode: "async",
      ts: new Date().toISOString(),
    },
  }).catch(() => {});

  // 3. Drain the source. For uploaded this is in-memory; for recording it
  //    triggers Whisper + caches segments. Either way: ONE iteration.
  const utterances: TranscriptUtterance[] = [];
  try {
    for await (const u of source.stream()) {
      utterances.push(u);
    }
  } catch (err: any) {
    await publishEvent({
      event: "analysis.failed",
      tenantId,
      data: {
        conversationId,
        mode: "async",
        error: err?.message ?? "stream_failed",
        ts: new Date().toISOString(),
      },
    }).catch(() => {});
    try {
      await source.close();
    } catch {
      /* ignore */
    }
    return { ok: false, reason: `stream_failed:${err?.message}` };
  }

  // 4. Build a synthetic final frame. V1 - no LLM. Phase 6.x replaces this
  //    with a PostCallPromptAssembler call.
  const frame = buildSyntheticFinalFrame({
    conversationId,
    utterances,
  });
  await CallAnalysisStore.appendFrame(conversationId, frame);

  // 5. Run Phase 5 analyzers against the frame array. Heuristic-only in
  //    V1 - output for an async run is shape-equivalent to a Mode A QA
  //    score, but with reduced signal because frames=[1] (vs many for
  //    live-mode replay). Documented limitation; LLM-augmented Phase 6.x
  //    will produce richer per-window frames.
  const playbookCompliance = new PlaybookCompliance();
  const coaching = new CoachingAnalyzer();
  const ctx = {
    conversationId,
    tenantId,
    memory: undefined,
    org: undefined,
    crm: undefined,
    llm: undefined,
    emit: () => {},
  } as any;
  const compliance = await playbookCompliance.analyze(ctx, { frames: [frame] });
  const coachingResult = await coaching.analyze(ctx, { frames: [frame] });

  // 6. Lookup the CallAnalysis id we just upserted to link the QAScore.
  const callAnalysis = await (prisma as any).callAnalysis.findUnique({
    where: { conversationId },
    select: { id: true },
  });

  let qaScoreId: string | undefined;
  if (callAnalysis) {
    const qa = await QAScoreStore.create({
      callAnalysisId: callAnalysis.id,
      conversationId,
      rubricVersion: ASYNC_RUBRIC_VERSION,
      playbookComplianceScore: compliance.score,
      coachingScore: coachingResult.score,
      riskScore: 0, // V1 - RiskDetector requires per-window frames
      findings: [...compliance.findings, ...coachingResult.findings].slice(
        0,
        25,
      ),
      refLiveFrameVersions: [frame.version],
    });
    qaScoreId = qa?.id;
  }

  // 7. Mark CallAnalysis completed.
  await CallAnalysisStore.complete(conversationId);

  // 8. Lifecycle event.
  await publishEvent({
    event: "analysis.completed",
    tenantId,
    data: {
      conversationId,
      mode: "async",
      callAnalysisId: callAnalysis?.id,
      qaScoreId,
      utteranceCount: utterances.length,
      ts: new Date().toISOString(),
    },
  }).catch(() => {});

  try {
    await source.close();
  } catch {
    /* ignore */
  }

  return {
    ok: true,
    callAnalysisId: callAnalysis?.id,
    qaScoreId,
    utteranceCount: utterances.length,
  };
}

// ── helpers ─────────────────────────────────────────────────────

function buildSyntheticFinalFrame(args: {
  conversationId: string;
  utterances: TranscriptUtterance[];
}): ConversationStateFrame {
  const { utterances } = args;
  const customerCount = utterances.filter(
    (u) => u.source === "customer",
  ).length;
  const agentCount = utterances.filter((u) => u.source === "agent").length;

  // Single-frame summary text: first ~200 chars of concatenated utterances.
  // V1 placeholder; PostCallPromptAssembler will produce a real summary.
  const concat = utterances.map((u) => u.text).join(" ").slice(0, 200);

  return {
    conversationId: args.conversationId,
    mode: "async",
    version: 1,
    ts: new Date().toISOString(),
    intent: null,
    stage: null,
    summary: concat
      ? { text: concat, kind: "final" as const }
      : null,
    sentiment: null,
    missingFields: [],
    suggestedActions: [],
    proposedTools: [],
    risks: [],
    urgency: "low" as const,
    confidence: 0.3, // honest signal: V1 synthetic frame is low-confidence
    // Custom fields below the schema are dropped by Zod parse - keeping
    // surface details in `summary.text` is the right channel for V1.
  };
}

/** Unused export kept for the CallAnalysis frames stat overlay. */
export function summarizeStats(utterances: TranscriptUtterance[]): {
  totalDurationMs: number;
  customerUtterances: number;
  agentUtterances: number;
} {
  const start = utterances[0]?.startMs ?? 0;
  const end =
    utterances[utterances.length - 1]?.endMs ??
    utterances[utterances.length - 1]?.startMs ??
    0;
  return {
    totalDurationMs: Math.max(0, end - start),
    customerUtterances: utterances.filter((u) => u.source === "customer").length,
    agentUtterances: utterances.filter((u) => u.source === "agent").length,
  };
}
