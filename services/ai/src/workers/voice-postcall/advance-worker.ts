import { createWorker, prisma } from "@chatcenter/shared";
import type { Job, Worker } from "bullmq";
import {
  VOICE_POSTCALL_QUEUE_NAME,
  VOICE_POSTCALL_JOB_NAME,
  DEFAULT_VOICE_POSTCALL_JOB_OPTS,
  type VoicePostCallJobData,
  getVoicePostCallQueue,
} from "./queue";
import {
  summarizePostConversation,
  type PostConversationSummary,
} from "../../services/post-conversation-summarizer.service";
import { executeAction, type PlannedAction } from "../../services/action-executor.service";
import {
  getSummarizerAllowedFields,
  getPostConversationConfig,
} from "../../services/post-conversation-config.service";
import { applyPostConversationRules } from "../../services/post-conversation-rule-engine.service";
import {
  applyCrmPatchKindAware,
  createCrmTaskKindAware,
  getCrmIdentity,
} from "../../services/post-conversation-crm.service";
import { refreshCustomerBriefFromConversation } from "../../services/customer-brief.service";
import { loadExistingActionItems } from "../../services/existing-action-items.service";

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
  // Idempotent: skip when a real (non-placeholder) summary already exists.
  const existing = await prisma.callAnalysis.findUnique({
    where: { conversationId: ctx.conversationId },
    select: { finalSummary: true, meta: true },
  });
  const hasRealSummary =
    !!existing?.finalSummary &&
    existing.finalSummary.trim() &&
    existing.finalSummary !== "[summary pending]";
  if (hasRealSummary && (existing!.meta as any)?.structured) {
    return null;
  }

  const [allowedFields, config, existingActionItems] = await Promise.all([
    getSummarizerAllowedFields(ctx.tenantId),
    getPostConversationConfig(ctx.tenantId),
    loadExistingActionItems({ tenantId: ctx.tenantId, conversationId: ctx.conversationId }),
  ]);
  const rawSummary: PostConversationSummary = await summarizePostConversation({
    tenantId: ctx.tenantId,
    conversationId: ctx.conversationId,
    channel: "voice",
    allowedFields,
    existingActionItems,
  });
  // Apply tenant rule engine on top of the LLM output. Rules ADD tasks and
  // CRM patch entries; they never overwrite what the AI extracted.
  const structured = applyPostConversationRules(rawSummary, config);

  // Persist the human-readable summary on finalSummary and the full
  // structured object on meta.structured so the next stage (ACTION_ITEMS /
  // CRM_WRITTEN) can consume it without re-prompting.
  await prisma.callAnalysis.upsert({
    where: { conversationId: ctx.conversationId },
    create: {
      tenantId: ctx.tenantId,
      conversationId: ctx.conversationId,
      callSid: ctx.callSid,
      mode: "live",
      status: "completed",
      frames: [],
      finalSummary: structured.summary || null,
      completedAt: new Date(),
      meta: { structured } as any,
    },
    update: {
      finalSummary: structured.summary || undefined,
      status: "completed",
      completedAt: new Date(),
      meta: { ...((existing?.meta as any) ?? {}), structured } as any,
    },
  });

  // Mirror to Conversation.aiSummary so the workspace cards see it without
  // needing to join through CallAnalysis. Only when non-empty — we never
  // wipe a previously-good summary.
  if (structured.summary) {
    await prisma.conversation.update({
      where: { id: ctx.conversationId },
      data: { aiSummary: structured.summary },
    }).catch(() => { /* best-effort */ });
  }

  return {
    summarized: !structured.empty,
    sentiment: structured.sentiment,
    intent: structured.intent,
    mentionedFields: structured.mentioned_fields,
    suggestedTaskCount: structured.suggested_tasks.length,
    hasFollowup: !!structured.suggested_followup,
    hasStatusChange: !!structured.status_change,
  };
}

async function loadStructured(conversationId: string): Promise<PostConversationSummary | null> {
  const row = await prisma.callAnalysis.findUnique({
    where: { conversationId },
    select: { meta: true },
  });
  const structured = (row?.meta as any)?.structured as PostConversationSummary | undefined;
  return structured ?? null;
}

async function findContactId(ctx: AdvanceContext): Promise<string | null> {
  const conv = await prisma.conversation.findUnique({
    where: { id: ctx.conversationId },
    select: { customerExternalId: true, channel: true },
  });
  if (!conv) return null;
  const contact = await prisma.contact.findFirst({
    where: {
      tenantId: ctx.tenantId,
      channel: conv.channel as any,
      externalId: conv.customerExternalId,
    },
    select: { id: true },
  });
  return contact?.id ?? null;
}

async function handleActionItemsExtracted(ctx: AdvanceContext): Promise<Record<string, unknown> | null> {
  const structured = await loadStructured(ctx.conversationId);
  if (!structured || structured.suggested_tasks.length === 0) {
    return { actionItemsExtracted: 0 };
  }

  // 1. Persist as VoiceCallActionItem rows (workspace card surface).
  //    Idempotent: skip rows that already exist for this session.
  const existing = await prisma.voiceCallActionItem.findMany({
    where: { sessionId: ctx.sessionId },
    select: { title: true },
  });
  const seen = new Set(existing.map((r) => r.title.toLowerCase().trim()));
  let created = 0;
  for (const task of structured.suggested_tasks) {
    const key = task.subject.toLowerCase().trim();
    if (seen.has(key)) continue;
    seen.add(key);
    await prisma.voiceCallActionItem.create({
      data: {
        sessionId: ctx.sessionId,
        title: task.subject,
        details: task.body ?? task.reason ?? null,
        status: "PROPOSED" as any,
      },
    });
    created++;
  }

  // 2. Materialize each suggested task in the vendor CRM on the right kind
  //    (Lead vs Contact). Identity resolved once, reused for all tasks.
  //
  //    Dedup is intent-based and happens UPSTREAM in handleSummarized: the
  //    summarizer LLM is given existing tasks + pending follow-ups as
  //    context and only emits suggestions that aren't already covered.
  const identity = await getCrmIdentity(ctx.tenantId, ctx.conversationId);
  let vendorTasksCreated = 0;
  const vendorTaskFailures: string[] = [];
  for (const task of structured.suggested_tasks) {
    const r = await createCrmTaskKindAware({
      tenantId: ctx.tenantId,
      conversationId: ctx.conversationId,
      task: {
        subject: task.subject,
        body: task.body ?? task.reason ?? "",
        priority: task.priority ?? "normal",
      },
      identity,
      sourceInteractionId: ctx.conversationId,
    });
    if (r.ok) vendorTasksCreated++;
    else if (r.reason && r.reason !== "no-adapter-task" && r.reason !== "no-crm-link") {
      vendorTaskFailures.push(`${task.subject}:${r.reason}`);
    }
  }

  return {
    actionItemsExtracted: created,
    totalProposed: structured.suggested_tasks.length,
    vendorTasksCreated,
    vendorTaskKind: identity.crmObjectKind,
    vendorTaskFailures: vendorTaskFailures.length > 0 ? vendorTaskFailures : undefined,
  };
}

async function handleCrmWritten(ctx: AdvanceContext): Promise<Record<string, unknown> | null> {
  const structured = await loadStructured(ctx.conversationId);
  if (!structured || structured.empty) {
    return { crmWriteSkipped: "no-summary" };
  }

  // Build the sparse field patch. Add `status` only when status_change is
  // present — it rides on the same update call.
  const fields: Record<string, unknown> = { ...structured.crm_patch };
  if (structured.status_change) {
    fields["status"] = structured.status_change.to;
  }
  if (Object.keys(fields).length === 0) {
    return { crmWriteSkipped: "no-fields" };
  }

  // Kind-aware vendor write — Leads vs Contacts route to the right module.
  // Falls back to a timeline note when the adapter can't patch the kind.
  const vendorResult = await applyCrmPatchKindAware({
    tenantId: ctx.tenantId,
    conversationId: ctx.conversationId,
    fields,
    sourceInteractionId: ctx.conversationId,
  });

  // ALSO patch the GOTCHA-side mirror Contact (this is what the local Contact
  // table holds — separate from the vendor row). Skipped when there's no
  // local Contact row.
  const contactId = await findContactId(ctx);
  let localResult: { ok?: boolean; skipReason?: string; error?: string } = {};
  if (contactId) {
    const action: PlannedAction = {
      tool: "update_contact",
      params: { contactId, fields },
      reason: `post-call CRM merge (intent=${structured.intent ?? "n/a"})`,
      riskLevel: "low",
    };
    const r = await executeAction(ctx.tenantId, action, {
      actorId: `voice-postcall:${ctx.sessionId}`,
    });
    localResult = { ok: r.ok, skipReason: r.skipReason, error: r.error };
  }

  return {
    crmWritten: vendorResult.ok,
    crmOutcome: vendorResult.outcome,
    crmKind: vendorResult.kind,
    crmFields: Object.keys(fields),
    crmSkipReason: vendorResult.reason,
    localContactUpdated: localResult.ok,
    localContactError: localResult.error,
  };
}

async function handleFollowupGenerated(ctx: AdvanceContext): Promise<Record<string, unknown> | null> {
  const structured = await loadStructured(ctx.conversationId);
  if (!structured?.suggested_followup) {
    return { followupSkipped: "no-followup" };
  }

  const contactId = await findContactId(ctx);
  if (!contactId) {
    return { followupSkipped: "no-contact" };
  }

  // Dedup against any PENDING ScheduledMessage already queued for this
  // conversation — the copilot/bot may have called schedule_followup
  // mid-call (e.g. caller said "תחזרו אליי מחר"). Re-scheduling here would
  // send two follow-ups.
  const hasPending = await hasPendingFollowupForConversation({
    tenantId: ctx.tenantId,
    conversationId: ctx.conversationId,
  });
  if (hasPending) {
    return { followupSkipped: "duplicate-pending" };
  }

  const followup = structured.suggested_followup;
  const action: PlannedAction = {
    tool: "schedule_followup",
    params: {
      contactId,
      body: followup.message,
      scheduleAt: followup.send_at_iso,
    },
    reason: followup.reason || "post-call follow-up",
    riskLevel: "low",
  };
  const result = await executeAction(ctx.tenantId, action, {
    actorId: `voice-postcall:${ctx.sessionId}`,
  });
  return {
    followupScheduled: result.ok,
    followupAt: followup.send_at_iso,
    followupSkipReason: result.skipReason,
    followupError: result.error,
  };
}

/**
 * True if there's already a PENDING ScheduledMessage queued for this
 * conversation's recipient. Best-effort. Final safety net even though the
 * summarizer LLM is fed existing follow-ups as context upstream.
 */
async function hasPendingFollowupForConversation(args: {
  tenantId: string;
  conversationId: string;
}): Promise<boolean> {
  try {
    const conv = await prisma.conversation.findUnique({
      where: { id: args.conversationId },
      select: { customerExternalId: true, channel: true },
    });
    if (!conv) return false;
    const row = await prisma.scheduledMessage.findFirst({
      where: {
        tenantId: args.tenantId,
        status: "PENDING" as any,
        channel: conv.channel as any,
        recipientExternalId: conv.customerExternalId,
      },
      select: { id: true },
    });
    return !!row;
  } catch {
    return false;
  }
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
    } else {
      // The call is fully post-processed (summary written, CRM hit, action
      // items extracted). Refresh the persistent customer brief so the next
      // agent picking up this customer sees the latest behavioral read.
      // Best-effort: a failure MUST NOT mark the pipeline as failed.
      refreshCustomerBriefFromConversation({
        tenantId: ctx.tenantId,
        conversationId: ctx.conversationId,
        sourceEvent: "voice.finalized",
      })
        .then((rec) => {
          if (rec) console.log(`[customer-brief] refreshed voice conv=${ctx.conversationId} identity=${rec.identityKey} locale=${rec.locale}`);
        })
        .catch((err) => {
          console.warn(
            `[customer-brief] refresh failed voice conv=${ctx.conversationId}:`,
            (err as { message?: string })?.message ?? err,
          );
        });
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
