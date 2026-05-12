import { createWorker, prisma } from "@chatcenter/shared";
import type { Job, Worker } from "bullmq";
import {
  VOICE_POSTCALL_QUEUE_NAME,
  VOICE_POSTCALL_JOB_NAME,
  DEFAULT_VOICE_POSTCALL_JOB_OPTS,
  type VoicePostCallJobData,
  getVoicePostCallQueue,
} from "./queue";

/**
 * Phase 1 — Live Call CoPilot post-call pipeline worker.
 *
 * Drives a `VoiceCallPostProcessing` row through the canonical stages:
 *   PENDING → TRANSCRIPT_FINALIZED → SUMMARIZED → ACTION_ITEMS_EXTRACTED
 *   → CRM_WRITTEN → FOLLOWUP_GENERATED → FINALIZED
 *
 * Each stage is idempotent — re-running on the same session is safe. On
 * exception, increments `attempts`, captures `lastError`, and re-enqueues
 * with exponential backoff up to 3 attempts (then marks `FAILED`).
 *
 * Concurrency 3 — the pipeline is bounded by external IO (LLM, CRM) rather
 * than CPU; this keeps a small fleet busy without thrashing.
 */

type Stage =
  | "PENDING"
  | "TRANSCRIPT_FINALIZED"
  | "SUMMARIZED"
  | "ACTION_ITEMS_EXTRACTED"
  | "CRM_WRITTEN"
  | "FOLLOWUP_GENERATED"
  | "FINALIZED"
  | "FAILED";

const STAGE_ORDER: Stage[] = [
  "PENDING",
  "TRANSCRIPT_FINALIZED",
  "SUMMARIZED",
  "ACTION_ITEMS_EXTRACTED",
  "CRM_WRITTEN",
  "FOLLOWUP_GENERATED",
  "FINALIZED",
];

function nextStage(current: Stage): Stage {
  const i = STAGE_ORDER.indexOf(current);
  if (i < 0 || i >= STAGE_ORDER.length - 1) return "FINALIZED";
  return STAGE_ORDER[i + 1]!;
}

let _worker: Worker<VoicePostCallJobData> | null = null;

interface AdvanceContext {
  sessionId: string;
  conversationId: string;
  tenantId: string;
  callSid: string;
}

async function loadCtx(sessionId: string): Promise<AdvanceContext | null> {
  const session = await prisma.voiceCallSession.findUnique({
    where: { id: sessionId },
    select: { id: true, conversationId: true, tenantId: true, callSid: true },
  });
  if (!session) return null;
  return {
    sessionId: session.id,
    conversationId: session.conversationId,
    tenantId: session.tenantId,
    callSid: session.callSid,
  };
}

function mergedMeta(existing: unknown, patch: Record<string, unknown>): Record<string, unknown> {
  const base = (existing && typeof existing === "object" ? (existing as Record<string, unknown>) : {});
  return { ...base, ...patch };
}

// ─── Stage handlers ────────────────────────────────────────────

async function handleTranscriptFinalized(_ctx: AdvanceContext): Promise<Record<string, unknown> | null> {
  // Marker stage — transcript writes are owned by voice-copilot's
  // PersistenceSink during the live call. Nothing to do here in Phase 1.
  return null;
}

async function handleSummarized(ctx: AdvanceContext): Promise<Record<string, unknown> | null> {
  // Idempotent: skip when a final summary already exists.
  const existing = await prisma.callAnalysis.findUnique({
    where: { conversationId: ctx.conversationId },
    select: { finalSummary: true },
  });
  if (existing?.finalSummary && existing.finalSummary.trim()) {
    return null;
  }
  // TODO: wire to the real summarizer. The intelligence engine's
  // CallAnalysisStore.complete() accepts a finalSummary string; a future
  // commit can replace this placeholder by reading the persisted frames
  // and asking the LLM for a final summary.
  await prisma.callAnalysis.upsert({
    where: { conversationId: ctx.conversationId },
    create: {
      tenantId: ctx.tenantId,
      conversationId: ctx.conversationId,
      callSid: ctx.callSid,
      mode: "live",
      status: "completed",
      frames: [],
      finalSummary: "[summary pending]",
      completedAt: new Date(),
    },
    update: {
      finalSummary: "[summary pending]",
      status: "completed",
      completedAt: new Date(),
    },
  });
  return { summaryPlaceholder: true };
}

async function handleActionItemsExtracted(ctx: AdvanceContext): Promise<Record<string, unknown> | null> {
  // Read voice messages for the conversation. A real LLM extractor isn't
  // available in the codebase yet — if one is added (search for
  // `extractActionItems`) it can be plugged in here. For Phase 1 we record
  // zero items and continue cleanly.
  const messages = await prisma.message.findMany({
    where: { conversationId: ctx.conversationId, channel: "VOICE" },
    orderBy: { createdAt: "asc" },
    select: { id: true, body: true, direction: true },
  });
  // Phase 1 placeholder — zero items.
  void messages;
  return { actionItemsExtracted: 0 };
}

async function handleCrmWritten(_ctx: AdvanceContext): Promise<Record<string, unknown> | null> {
  // No reusable CRM-note helper exists in the AI service today. Mark
  // skipped — a future packet can wire this through the shared CRM client.
  return { crmWriteSkipped: true };
}

async function handleFollowupGenerated(_ctx: AdvanceContext): Promise<Record<string, unknown> | null> {
  // `generateFollowup` (services/ai/src/services/followup-generator.service.ts)
  // generates a re-engagement message but isn't part of the spec for Phase 1
  // post-call (it targets idle text conversations). Mark skipped.
  return { followupSkipped: true };
}

async function handleFinalized(_ctx: AdvanceContext): Promise<Record<string, unknown> | null> {
  return { finishedAt: new Date().toISOString() };
}

// ─── Worker entrypoint ────────────────────────────────────────

export async function advanceVoicePostCall(sessionId: string): Promise<void> {
  const row = await prisma.voiceCallPostProcessing.findUnique({ where: { sessionId } });
  if (!row) return;
  const currentStage = row.stage as Stage;
  if (currentStage === "FINALIZED" || currentStage === "FAILED") {
    return;
  }
  const ctx = await loadCtx(sessionId);
  if (!ctx) {
    await prisma.voiceCallPostProcessing.update({
      where: { sessionId },
      data: { stage: "FAILED", lastError: "session_not_found", finishedAt: new Date() },
    });
    return;
  }

  const target = nextStage(currentStage);
  try {
    let patch: Record<string, unknown> | null = null;
    switch (target) {
      case "TRANSCRIPT_FINALIZED":
        patch = await handleTranscriptFinalized(ctx);
        break;
      case "SUMMARIZED":
        patch = await handleSummarized(ctx);
        break;
      case "ACTION_ITEMS_EXTRACTED":
        patch = await handleActionItemsExtracted(ctx);
        break;
      case "CRM_WRITTEN":
        patch = await handleCrmWritten(ctx);
        break;
      case "FOLLOWUP_GENERATED":
        patch = await handleFollowupGenerated(ctx);
        break;
      case "FINALIZED":
        patch = await handleFinalized(ctx);
        break;
      default:
        patch = null;
    }
    await prisma.voiceCallPostProcessing.update({
      where: { sessionId },
      data: {
        stage: target,
        attempts: 0,
        lastError: null,
        ...(target === "FINALIZED" ? { finishedAt: new Date() } : {}),
        ...(patch ? { meta: mergedMeta(row.meta, patch) } : {}),
      },
    });

    // Auto-advance until we hit FINALIZED. Re-enqueue rather than recurse so
    // each step gets its own BullMQ retry surface.
    if (target !== "FINALIZED") {
      await getVoicePostCallQueue().add(
        VOICE_POSTCALL_JOB_NAME,
        { sessionId },
        // BullMQ rejects `:` in custom job ids (Redis key separator).
        { ...DEFAULT_VOICE_POSTCALL_JOB_OPTS, jobId: `voice-postcall-${sessionId}-${target}` },
      );
    }
  } catch (err) {
    const message = (err as { message?: string })?.message ?? "unknown_error";
    const attempts = row.attempts + 1;
    const isTerminal = attempts >= 3;
    await prisma.voiceCallPostProcessing.update({
      where: { sessionId },
      data: {
        attempts: { increment: 1 },
        lastError: message,
        stage: isTerminal ? "FAILED" : (currentStage as Stage),
        ...(isTerminal ? { finishedAt: new Date() } : {}),
      },
    });
    if (!isTerminal) {
      const delay = 1000 * Math.pow(2, attempts);
      await getVoicePostCallQueue().add(
        VOICE_POSTCALL_JOB_NAME,
        { sessionId },
        {
          ...DEFAULT_VOICE_POSTCALL_JOB_OPTS,
          delay,
          jobId: `voice-postcall-${sessionId}-retry-${attempts}`,
        },
      );
    }
  }
}

export function startVoicePostCallAdvanceWorker(): Worker<VoicePostCallJobData> {
  if (_worker) return _worker;
  _worker = createWorker<VoicePostCallJobData>(
    VOICE_POSTCALL_QUEUE_NAME,
    async (job: Job<VoicePostCallJobData>) => {
      const data = job.data;
      if (!data?.sessionId) {
        console.warn("[voice-postcall.worker] malformed job payload — skipped", job.id);
        return;
      }
      await advanceVoicePostCall(data.sessionId);
    },
    { concurrency: 3 },
  );
  console.log(
    `[voice-postcall] advance worker started (queue=${VOICE_POSTCALL_QUEUE_NAME})`,
  );
  return _worker;
}

export async function stopVoicePostCallAdvanceWorker(): Promise<void> {
  if (!_worker) return;
  await _worker.close();
  _worker = null;
}
