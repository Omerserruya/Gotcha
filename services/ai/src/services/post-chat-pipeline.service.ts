/**
 * Post-chat pipeline - one-shot end-of-conversation processor for text
 * channels (WhatsApp, Messenger, Webchat, ...).
 *
 * Triggered by the `conversation:closed` event when a non-voice conversation
 * is closed (voice has its own multi-stage VoiceCallPostProcessing pipeline).
 *
 * Steps (each step swallows its own errors so later steps still run):
 *   1. Summarize the transcript → structured PostConversationSummary
 *   2. Persist summary to Conversation.aiSummary + CallAnalysis.meta.structured
 *   3. Apply sparse CRM patch via action-executor.update_contact
 *   4. Write the summary onto the vendor customer record as a note
 *   5. Create CRM task per suggested_task via action-executor.create_task
 *   6. Schedule follow-up via action-executor.schedule_followup
 *
 * Sparse-patch contract: only fields the AI marked as `mentioned_fields`
 * are written; prior CRM data is preserved (see feedback memory
 * "post-conversation-crm-merge").
 */

import { prisma, isEntitled } from "@chatcenter/shared";
import { summarizePostConversation } from "./post-conversation-summarizer.service";
import { resolveEffectiveLocale } from "@chatcenter/shared";
import { executeAction, type PlannedAction } from "./action-executor.service";
import {
  getSummarizerAllowedFields,
  getPostConversationConfig,
} from "./post-conversation-config.service";
import { applyPostConversationRules } from "./post-conversation-rule-engine.service";
import { applyCrmPatchKindAware, createCrmTaskKindAware, getCrmIdentity, writeSummaryNoteKindAware } from "./post-conversation-crm.service";
import { loadExistingActionItems } from "./existing-action-items.service";
import { ingestConversationFacts } from "./intelligence-ingest.service";

/**
 * How long a claim is honoured before another run may take it over.
 *
 * The pipeline makes an LLM call and several vendor round trips, so a healthy
 * run can legitimately take tens of seconds. The cutoff only has to exceed
 * that; its real job is to make sure a worker that died mid-run does not lock
 * a conversation out of summarisation forever.
 */
const CLAIM_STALE_MS = 10 * 60 * 1000;

/**
 * Atomically take ownership of a conversation's post-chat run.
 *
 * The previous guard read CallAnalysis, decided "not processed yet", and then
 * spent seconds summarising before writing anything. Two deliveries of
 * `conversation:closed` - a redelivery, a retry, or a close racing a reopen -
 * both passed that read and both ran to completion. The visible result was not
 * a duplicated row: `upsert` collapses those. It was a SECOND note on the
 * customer's record in the merchant's CRM, and a second task, because those
 * writes go to a vendor that has no idea we already wrote them.
 *
 * The claim is a conditional UPDATE, so the database decides the winner:
 * exactly one caller sees a row count of 1.
 *
 * It cannot key off `status`, which looks like the obvious field. The
 * intelligence runner (`CallAnalysisStore.ensure`) creates rows with
 * `status: "running"` for its own reasons, so treating that as "a post-chat
 * run owns this" would skip every conversation the runner had touched.
 * `meta.postChatClaimAt` is written by this pipeline and nothing else.
 */
async function claimPostChatRun(conversationId: string, tenantId: string): Promise<boolean> {
  // The row may not exist yet - the CAS below can only claim an existing row,
  // and an UPDATE matching nothing is indistinguishable from losing the race.
  try {
    await (prisma as any).callAnalysis.upsert({
      where: { conversationId },
      create: { tenantId, conversationId, mode: "chat", status: "running", frames: [] },
      update: {},
    });
  } catch {
    // A concurrent create won; the row now exists either way, which is all the
    // CAS needs.
  }

  const cutoff = new Date(Date.now() - CLAIM_STALE_MS).toISOString();
  try {
    const claimed: number = await (prisma as any).$executeRaw`
      UPDATE call_analyses
      SET meta = COALESCE(meta, '{}'::jsonb)
                 || jsonb_build_object('postChatClaimAt', ${new Date().toISOString()})
      WHERE conversation_id = ${conversationId}
        AND (
          meta->>'postChatClaimAt' IS NULL
          OR (meta->>'postChatClaimAt') < ${cutoff}
        )
    `;
    return claimed > 0;
  } catch (err: any) {
    // Fail OPEN. A claim that cannot be taken must not stop a paying customer's
    // conversation being summarised; the duplicate-write risk it guards against
    // is the lesser harm, and it is logged.
    console.error(`[post-chat] claim failed for conv=${conversationId}, proceeding: ${err?.message}`);
    return true;
  }
}

/**
 * Drop the claim so a retry can start immediately.
 *
 * Only for runs that ended WITHOUT writing anything downstream. A completed run
 * leaves its claim in place and is caught by the `already-processed` fast path
 * instead, which is keyed on the summary actually being on disk.
 */
async function releasePostChatRun(conversationId: string): Promise<void> {
  try {
    await (prisma as any).$executeRaw`
      UPDATE call_analyses
      SET meta = COALESCE(meta, '{}'::jsonb) - 'postChatClaimAt'
      WHERE conversation_id = ${conversationId}
    `;
  } catch {
    // Non-fatal: the claim expires on its own after CLAIM_STALE_MS.
  }
}

export async function runPostChatPipeline(params: {
  tenantId: string;
  conversationId: string;
  actorId?: string;
}): Promise<{
  ok: boolean;
  summarized: boolean;
  crmWritten: boolean;
  /** The summary was written onto the vendor customer record as a note. */
  summaryNoteWritten: boolean;
  tasksCreated: number;
  followupScheduled: boolean;
  notes: string[];
}> {
  const notes: string[] = [];

  // 0a. Commercial gate.
  //
  // The catalog has always CLAIMED this is enforced here - `communication.
  // crm_summaries` carries enforcementLocations:
  // ["services/ai:post-conversation.summary"] - and it was not. Summaries and
  // CRM writeback ran for every tenant regardless of plan, so the boundary
  // existed in the catalog and nowhere else.
  //
  // Gated on `communication.crm_summaries` and DELIBERATELY NOT on
  // `ai.employee` or `ai.copilot`. Foundation grants summaries while denying
  // both of those, and that combination is a product requirement: a plan
  // without AI employees can still get its conversations summarised. Coupling
  // this to an AI entitlement would silently kill that.
  //
  // Fails OPEN on a resolution error. This is a background subscriber, not a
  // payment path; a database blip must not silently stop summarising for
  // paying customers, and the error is logged so it is visible.
  try {
    const entitled = await isEntitled(params.tenantId, "communication.crm_summaries");
    if (!entitled) {
      return {
        ok: true, summarized: false, crmWritten: false, summaryNoteWritten: false, tasksCreated: 0,
        followupScheduled: false, notes: ["not-entitled:communication.crm_summaries"],
      };
    }
  } catch (err: any) {
    console.error(
      `[post-chat] entitlement check failed for tenant=${params.tenantId}; ` +
        `proceeding (fail-open on a background path): ${err?.message}`,
    );
  }

  // 0. Guard - don't run twice on the same conversation.
  //
  // Two layers, because they catch different things. This read catches the
  // common case cheaply: a redelivery arriving after a previous run finished.
  const existing = await prisma.callAnalysis.findUnique({
    where: { conversationId: params.conversationId },
    select: { meta: true, finalSummary: true },
  });
  if (existing?.finalSummary && (existing.meta as any)?.structured) {
    return { ok: true, summarized: false, crmWritten: false, summaryNoteWritten: false, tasksCreated: 0, followupScheduled: false, notes: ["already-processed"] };
  }

  // The read above cannot catch a CONCURRENT delivery: both callers see no
  // summary, both continue, and both write a note to the merchant's CRM. The
  // claim is atomic, so exactly one proceeds.
  if (!(await claimPostChatRun(params.conversationId, params.tenantId))) {
    return { ok: true, summarized: false, crmWritten: false, summaryNoteWritten: false, tasksCreated: 0, followupScheduled: false, notes: ["claimed-by-another-run"] };
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
    // background subscriber with no user context - use the tenant default.
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
    // Nothing was written anywhere, so hand the claim back rather than making a
    // legitimate retry wait out CLAIM_STALE_MS.
    await releasePostChatRun(params.conversationId);
    return { ok: false, summarized: false, crmWritten: false, summaryNoteWritten: false, tasksCreated: 0, followupScheduled: false, notes: ["empty-summary"] };
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
  let summaryNoteWritten = false;
  let tasksCreated = 0;
  let followupScheduled = false;

  // 3b. Customer Intelligence V2 ingest (Phase 2) - route the extracted
  //     fields into the scope-aware model (CustomerProfile / Opportunity /
  //     IntelligenceFact) under the merge policy. ADDITIVE + best-effort: a
  //     failure here must never affect the legacy CRM/task path below.
  let oppScopedKeys = new Set<string>();
  try {
    const extracted = Object.entries(structured.crm_patch).map(([key, value]) => ({ key, value }));
    if (extracted.length > 0) {
      const ing = await ingestConversationFacts({
        tenantId: params.tenantId,
        conversationId: params.conversationId,
        fields: extracted,
        source: "llm_close",
      });
      notes.push(`intel:${ing.ok ? `w${ing.written}/o${ing.opportunityId ? 1 : 0}` : ing.reason}`);
    }
    // Opportunity-scoped fields belong on the CRM *deal* (P5), not the contact.
    // Keep them OUT of the contact patch so we don't repeat V1's "everything on
    // the contact" mistake. Customer-scoped + built-in fields still flow to CRM.
    const oppDefs = await (prisma as any).fieldDefinition.findMany({
      where: { tenantId: params.tenantId, scope: "OPPORTUNITY" },
      select: { key: true },
    });
    oppScopedKeys = new Set(oppDefs.map((d: { key: string }) => d.key));
  } catch (err: any) {
    notes.push(`intel:err:${err?.message ?? "unknown"}`);
  }

  // 4. Sparse CRM patch (only mentioned_fields are present, by construction).
  //    Kind-aware: Leads vs Contacts route to the right vendor module; falls
  //    back to a timeline note if the adapter can't patch the kind.
  //    Opportunity-scoped intelligence fields are excluded (they sync to the
  //    CRM deal in P5, not the contact).
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(structured.crm_patch)) {
    if (!oppScopedKeys.has(k)) fields[k] = v;
  }
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

  // 5. CRM tasks per suggested_task - kind-aware path first; falls back to
  //    the legacy contact-only create_task when the vendor adapter can't
  //    create tasks (e.g. NoOp). Identity resolved once, reused for all.
  //
  //    Dedup is intent-based, decided by the summarizer LLM: existing tasks
  //    + pending follow-ups are loaded above and passed into the summarizer
  //    so it only emits tasks/follow-ups that aren't already covered.
  const identity = await getCrmIdentity(params.tenantId, params.conversationId);

  // 4b. The summary itself, onto the customer's record in the merchant's CRM.
  //
  //     Everything above persists the summary GOTCHA-side only (CallAnalysis
  //     + Conversation.aiSummary). The only vendor write was the sparse FIELD
  //     patch, and its note fallback runs ONLY when that patch fails — which
  //     on Shopify it doesn't, because `updateRecord` maps to a real
  //     `shopify.update_customer` call. Net effect: a merchant reading their
  //     own Shopify customer record saw no trace of the conversation and had
  //     to come back to GOTCHA to find out what happened.
  //
  //     Ordered AFTER the field patch on purpose: `shopify.create_note` is a
  //     read-modify-write on `customer.note`, so running it second keeps it
  //     from racing the field update on the same record. Best-effort — a
  //     vendor failure here must not cost us the tasks and follow-up below.
  const summaryNote = await writeSummaryNoteKindAware({
    tenantId: params.tenantId,
    conversationId: params.conversationId,
    summary: structured.summary,
    identity,
    sourceInteractionId: params.conversationId,
  }).catch((err: any) => ({
    ok: false as const,
    outcome: "skipped" as const,
    crmContactId: null,
    reason: `threw:${err?.message ?? "unknown"}`,
  }));
  summaryNoteWritten = summaryNote.ok;
  notes.push(`summary-note:${summaryNote.ok ? "ok" : summaryNote.reason ?? "failed"}`);

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
    // Vendor declined - try legacy contact-only path so the GOTCHA-side
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

  // 6. Follow-up - dedup against any PENDING ScheduledMessage already queued
  //    for this contact. The bot may have called schedule_followup mid-turn
  //    (e.g. customer said "תחזרו אליי מחר"), in which case there's already
  //    a row waiting for the scheduled-messages worker - re-scheduling here
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
    summaryNoteWritten,
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
