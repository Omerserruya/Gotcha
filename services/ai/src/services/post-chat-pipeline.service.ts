/**
 * Post-chat pipeline — one-shot end-of-conversation processor for text
 * channels (WhatsApp, Messenger, Webchat, ...).
 *
 * Triggered by the `conversation:closed` event when a non-voice conversation
 * is closed (voice has its own multi-stage VoiceCallPostProcessing pipeline).
 *
 * Steps (each step swallows its own errors so later steps still run):
 *   1. Summarize the transcript → structured PostConversationSummary
 *   2. Persist summary to Conversation.aiSummary + CallAnalysis.meta.structured
 *   3. Apply sparse CRM patch via action-executor.update_contact
 *   4. Create CRM task per suggested_task via action-executor.create_task
 *   5. Schedule follow-up via action-executor.schedule_followup
 *
 * Sparse-patch contract: only fields the AI marked as `mentioned_fields`
 * are written; prior CRM data is preserved (see feedback memory
 * "post-conversation-crm-merge").
 */

import { prisma } from "@chatcenter/shared";
import { summarizePostConversation } from "./post-conversation-summarizer.service";
import { resolveEffectiveLocale } from "@chatcenter/shared";
import { executeAction, type PlannedAction } from "./action-executor.service";
import {
  getSummarizerAllowedFields,
  getPostConversationConfig,
} from "./post-conversation-config.service";
import { applyPostConversationRules } from "./post-conversation-rule-engine.service";
import { applyCrmPatchKindAware, createCrmTaskKindAware, getCrmIdentity } from "./post-conversation-crm.service";
import { loadExistingActionItems } from "./existing-action-items.service";

export async function runPostChatPipeline(params: {
  tenantId: string;
  conversationId: string;
  actorId?: string;
}): Promise<{
  ok: boolean;
  summarized: boolean;
  crmWritten: boolean;
  tasksCreated: number;
  followupScheduled: boolean;
  notes: string[];
}> {
  const notes: string[] = [];

  // 0. Guard — don't run twice on the same conversation.
  const existing = await prisma.callAnalysis.findUnique({
    where: { conversationId: params.conversationId },
    select: { meta: true, finalSummary: true },
  });
  if (existing?.finalSummary && (existing.meta as any)?.structured) {
    return { ok: true, summarized: false, crmWritten: false, tasksCreated: 0, followupScheduled: false, notes: ["already-processed"] };
  }

  // 1. Summarize + apply tenant rule engine.
  //    Existing tasks + pending follow-ups are loaded deterministically and
  //    passed to the summarizer as context. The LLM uses them to dedup by
  //    INTENT (not literal subject match) and only emits suggestions that
  //    aren't already covered by mid-conversation tool calls.
  const [allowedFields, config, existingActionItems, localeInfo] = await Promise.all([
    getSummarizerAllowedFields(params.tenantId),
    getPostConversationConfig(params.tenantId),
    loadExistingActionItems({ tenantId: params.tenantId, conversationId: params.conversationId }),
    // System language drives the AI summary copy. Post-chat runs in a
    // background subscriber with no user context — use the tenant default.
    resolveEffectiveLocale({ tenantId: params.tenantId }).catch(() => null),
  ]);
  const raw = await summarizePostConversation({
    tenantId: params.tenantId,
    conversationId: params.conversationId,
    channel: "chat",
    allowedFields,
    existingActionItems,
    locale: localeInfo?.effective,
  });
  const structured = applyPostConversationRules(raw, config);
  if (structured.empty || !structured.summary) {
    return { ok: false, summarized: false, crmWritten: false, tasksCreated: 0, followupScheduled: false, notes: ["empty-summary"] };
  }

  // 2. Persist.
  try {
    await (prisma as any).callAnalysis.upsert({
      where: { conversationId: params.conversationId },
      create: {
        tenantId: params.tenantId,
        conversationId: params.conversationId,
        mode: "chat",
        status: "completed",
        frames: [],
        finalSummary: structured.summary,
        completedAt: new Date(),
        meta: { structured } as any,
      },
      update: {
        finalSummary: structured.summary,
        status: "completed",
        completedAt: new Date(),
        meta: { ...((existing?.meta as any) ?? {}), structured } as any,
      },
    });
    await prisma.conversation.update({
      where: { id: params.conversationId },
      data: { aiSummary: structured.summary },
    }).catch(() => undefined);
  } catch (err: any) {
    notes.push(`persist-failed:${err?.message ?? "unknown"}`);
  }

  // 3. Resolve the contact for downstream action-executor calls.
  const conv = await prisma.conversation.findUnique({
    where: { id: params.conversationId },
    select: { customerExternalId: true, channel: true },
  });
  const contact = conv
    ? await prisma.contact.findFirst({
        where: {
          tenantId: params.tenantId,
          channel: conv.channel as any,
          externalId: conv.customerExternalId,
        },
        select: { id: true },
      })
    : null;
  const contactId = contact?.id ?? null;
  const actor = params.actorId ?? `post-chat:${params.conversationId}`;

  let crmWritten = false;
  let tasksCreated = 0;
  let followupScheduled = false;

  // 4. Sparse CRM patch (only mentioned_fields are present, by construction).
  //    Kind-aware: Leads vs Contacts route to the right vendor module; falls
  //    back to a timeline note if the adapter can't patch the kind.
  const fields: Record<string, unknown> = { ...structured.crm_patch };
  if (structured.status_change) fields["status"] = structured.status_change.to;
  if (Object.keys(fields).length > 0) {
    const vendorRes = await applyCrmPatchKindAware({
      tenantId: params.tenantId,
      conversationId: params.conversationId,
      fields,
      sourceInteractionId: params.conversationId,
    });
    crmWritten = vendorRes.ok;
    if (!vendorRes.ok) notes.push(`crm:${vendorRes.reason ?? "failed"}`);
    else notes.push(`crm:${vendorRes.outcome}:${vendorRes.kind ?? "n/a"}`);

    // Also patch the GOTCHA-side mirror Contact for the local cache.
    if (contactId) {
      const action: PlannedAction = {
        tool: "update_contact",
        params: { contactId, fields },
        reason: `post-chat CRM merge (intent=${structured.intent ?? "n/a"})`,
        riskLevel: "low",
      };
      const r = await executeAction(params.tenantId, action, { actorId: actor });
      if (!r.ok) notes.push(`local-contact:${r.skipReason ?? r.error ?? "failed"}`);
    }
  } else {
    notes.push("crm:no-fields");
  }

  // 5. CRM tasks per suggested_task — kind-aware path first; falls back to
  //    the legacy contact-only create_task when the vendor adapter can't
  //    create tasks (e.g. NoOp). Identity resolved once, reused for all.
  //
  //    Dedup is intent-based, decided by the summarizer LLM: existing tasks
  //    + pending follow-ups are loaded above and passed into the summarizer
  //    so it only emits tasks/follow-ups that aren't already covered.
  const identity = await getCrmIdentity(params.tenantId, params.conversationId);
  for (const t of structured.suggested_tasks) {
    const vendor = await createCrmTaskKindAware({
      tenantId: params.tenantId,
      conversationId: params.conversationId,
      task: {
        subject: t.subject,
        body: t.body ?? t.reason ?? "",
        priority: t.priority ?? "normal",
      },
      identity,
      sourceInteractionId: params.conversationId,
    });
    if (vendor.ok) {
      tasksCreated++;
      notes.push(`task:${vendor.kind}:ok`);
      continue;
    }
    // Vendor declined — try legacy contact-only path so the GOTCHA-side
    // mirror still gets the task.
    if (contactId) {
      const action: PlannedAction = {
        tool: "create_task",
        params: {
          contactId,
          subject: t.subject,
          body: t.body ?? t.reason ?? "",
          priority: t.priority ?? "normal",
        },
        reason: t.reason,
        riskLevel: "low",
      };
      const res = await executeAction(params.tenantId, action, { actorId: actor });
      if (res.ok) {
        tasksCreated++;
        notes.push(`task:legacy:ok`);
      } else {
        notes.push(`task:${t.subject}:${vendor.reason ?? res.skipReason ?? res.error ?? "failed"}`);
      }
    } else {
      notes.push(`task:${t.subject}:${vendor.reason ?? "no-target"}`);
    }
  }

  // 6. Follow-up — dedup against any PENDING ScheduledMessage already queued
  //    for this contact. The bot may have called schedule_followup mid-turn
  //    (e.g. customer said "תחזרו אליי מחר"), in which case there's already
  //    a row waiting for the scheduled-messages worker — re-scheduling here
  //    would send the customer two follow-ups.
  if (contactId && structured.suggested_followup) {
    const hasPending = await hasPendingFollowupForConversation({
      tenantId: params.tenantId,
      conversationId: params.conversationId,
    });
    if (hasPending) {
      notes.push("followup:skipped-duplicate");
    } else {
      const f = structured.suggested_followup;
      const action: PlannedAction = {
        tool: "schedule_followup",
        params: { contactId, body: f.message, scheduleAt: f.send_at_iso },
        reason: f.reason,
        riskLevel: "low",
      };
      const res = await executeAction(params.tenantId, action, { actorId: actor });
      followupScheduled = res.ok;
      if (!res.ok) notes.push(`followup:${res.skipReason ?? res.error ?? "failed"}`);
    }
  }

  return {
    ok: true,
    summarized: true,
    crmWritten,
    tasksCreated,
    followupScheduled,
    notes,
  };
}

/**
 * True if there's already a PENDING ScheduledMessage queued for this
 * conversation (i.e. the bot called schedule_followup mid-turn). Final
 * safety net: even when the summarizer LLM is given existing follow-ups
 * as context, we still guard against accidentally double-scheduling.
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
