/**
 * The relevance label for every conversation (2026-11-17, docs/architecture/conversation-relevance.md).
 * NEEDS the a6459560 columns.
 *
 * incoming-worker enqueues one job per conversation per 2 minutes after an inbound (enqueueRelevanceClassification,
 * RELEVANCE_CLASSIFY_TENANTS). This runs the SAME path as the reply engine's Gate 1 in shadow mode
 * (relevanceForTurn): a person's override first and untouched, the re-run rule, the classifier, and the write
 * through the conversation service's internal route. It labels; it never decides a reply.
 */
import { createWorker, prisma, relevanceClassifyEnabled, RELEVANCE_QUEUE } from "@chatcenter/shared";
import { getCompanyContext } from "../../services/company-context.service";
import { relevanceForTurn, type RelevanceGateDeps, type RelevanceGateResult } from "../../services/reply-engine/relevance-gate";

export interface RelevanceJob { tenantId: string; conversationId: string }

export async function processRelevanceJob(job: RelevanceJob, deps: RelevanceGateDeps & { db?: any; company?: typeof getCompanyContext } = {}): Promise<RelevanceGateResult | null> {
  const { tenantId, conversationId } = job ?? ({} as RelevanceJob);
  if (!tenantId || !conversationId || !relevanceClassifyEnabled(tenantId)) return null;
  const db = deps.db ?? prisma;
  const conversation = await db.conversation.findFirst({ where: { id: conversationId, tenantId } });
  if (!conversation || String(conversation.customerExternalId ?? "").startsWith("sandbox:")) return null;
  const last: any[] = await db.message.findMany({
    where: { tenantId, conversationId },
    orderBy: { createdAt: "desc" },
    take: 12,
    select: { direction: true, body: true, createdAt: true, messageType: true, metadata: true },
  });
  const company: any = await (deps.company ?? getCompanyContext)(tenantId).catch(() => null);
  return relevanceForTurn({ tenantId, conversation, history: last.reverse(), profile: company ? { ...company } : null, mode: "shadow" }, { ...deps, db });
}

export function startRelevanceWorker() {
  // Two at a time: small calls, never a burst against the model on a busy inbox.
  return createWorker<RelevanceJob>(RELEVANCE_QUEUE, async (job) => {
    const r = await processRelevanceJob(job.data);
    if (r?.source === "error") console.warn(`[relevance] label failed conv=${job.data.conversationId}`);
  }, 2);
}
