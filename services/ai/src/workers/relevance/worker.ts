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

export interface RelevanceJob {
  tenantId: string;
  conversationId: string;
  /** Enqueued right after the first inbound was labelled inline by the model (2026-11-22). */
  refine?: boolean;
}

/** Below this a model label from the inline pass is looked at again by its 2-minute job. */
export const REFINE_BELOW = 0.9;

/**
 * The inline label is refined once, by the job enqueued with it: only a MODEL label (a rule's answer is
 * final), only when it is not a person's, and only when it was unsure (under 0.9) or the customer wrote
 * again since it was made (more to read now).
 */
export function shouldRefine(conversation: any, history: Array<{ direction?: string; createdAt?: unknown }>): boolean {
  if (!conversation || conversation.relevanceOverriddenBy) return false;
  if (conversation.relevanceSource !== "model" || !conversation.relevanceClassifiedAt) return false;
  if (Number(conversation.relevanceConfidence ?? 0) < REFINE_BELOW) return true;
  const at = new Date(conversation.relevanceClassifiedAt).getTime();
  return history.some((m) => m?.direction === "INBOUND" && m.createdAt != null && new Date(m.createdAt as any).getTime() > at);
}

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
  // No customer waits on the worker (dev relevance test 2026-11-18: 4 of 15 labels lost at the inline gate's 3s):
  // its own timeout. The inline gate keeps 3s.
  const history = last.reverse();
  const fresh = job.refine === true && shouldRefine(conversation, history);
  return relevanceForTurn({ tenantId, conversation, history, profile: company ? { ...company } : null, mode: "shadow", fresh }, { timeoutMs: workerTimeoutMs(), ...deps, db });
}

/** The worker's classify timeout (RELEVANCE_WORKER_TIMEOUT_MS, default 20s). */
export function workerTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.RELEVANCE_WORKER_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 1000 ? n : 20_000;
}

/**
 * One job: a failed label throws so the queue tries again (3 attempts with backoff, see
 * enqueueRelevanceClassification); the conversation is logged as failed only after the last try.
 */
export async function runRelevanceJob(job: { data: RelevanceJob; attemptsMade?: number; opts?: { attempts?: number } }, process_ = processRelevanceJob): Promise<void> {
  const r = await process_(job.data);
  if (r?.source !== "error") return;
  const attempts = Number(job.opts?.attempts ?? 1);
  const thisTry = Number(job.attemptsMade ?? 0) + 1;
  if (thisTry >= attempts) {
    console.warn(`[relevance] label failed conv=${job.data.conversationId} after ${thisTry} tries`);
    return;
  }
  throw new Error(`relevance label failed (try ${thisTry} of ${attempts})`);
}

export function startRelevanceWorker() {
  // Two at a time: small calls, never a burst against the model on a busy inbox.
  return createWorker<RelevanceJob>(RELEVANCE_QUEUE, (job) => runRelevanceJob(job as any), 2);
}
