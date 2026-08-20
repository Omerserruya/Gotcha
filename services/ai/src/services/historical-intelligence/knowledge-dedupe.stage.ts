/**
 * Merge candidates that are the same question asked differently.
 *
 * Clustering is done with embeddings, and embeddings cannot carry this alone.
 * Measured on a real import (Mineraz, 2026-08-20, text-embedding-3-small):
 *
 *   "מהו טווח זמן האספקה להזמנה?"  vs  "כמה זמן לוקח עד לקבלת המשלוח?"   0.42
 *
 * Those are the same question. No single cosine threshold separates that pair
 * from two genuinely different questions - set it low enough to merge them and
 * unrelated topics collapse together. Hebrew paraphrase is simply not a
 * distance problem, so this stage asks a language model instead, once, over
 * the candidates that survived pruning.
 *
 * It runs AFTER clustering, on tens of items rather than thousands, so it is
 * one cheap call at the end rather than a cost multiplier on extraction.
 *
 * ── What merging preserves ──
 *
 * Evidence is REASSIGNED, never dropped: the merged candidate keeps every
 * conversation behind every phrasing, which is the whole basis of "found in N
 * conversations". Occurrence counts add up; the customer count is the size of
 * the UNION of customers, recomputed from evidence rather than summed, because
 * one customer who asked twice in different words is one customer.
 */
import { z } from "zod";
import { prisma } from "@chatcenter/shared";
import { structuredCall } from "./llm";
import { recordEvent, tenantPromptLanguage, languageDirective, type StageResult } from "./stage-utils";
import { scoreConfidence } from "./knowledge-clustering.stage";
import { dropCandidateVectors } from "./candidate-index";

/** More than this in one call and the model starts losing track of the ids. */
const BATCH = 60;

/** Distinct answers kept on a merged candidate, mirroring extraction. */
const MAX_VARIANTS = 3;

const GroupSchema = z.object({
  /** Ids that are the same question. A single id means "leave it alone". */
  ids: z.array(z.string()).min(1),
  /** The clearest phrasing for the merged question, in the org's language. */
  question: z.string().min(5).max(300),
  /** A short topic for the merged item. */
  topic: z.string().min(2).max(60),
});

const DedupeSchema = z.object({ groups: z.array(GroupSchema) });

const SYSTEM_PROMPT = `You are given a list of question/answer candidates mined from one business's past conversations. Several of them are THE SAME QUESTION phrased differently, because they were written from different conversations.

Group them.

GROUP TOGETHER only when a single answer would serve every question in the group. "Where can I follow you on social media?", "Which social channels are you on?" and "Where can I find the brand online?" are ONE question. "How long does delivery take?" and "How do I track my order?" are TWO - one is about time, the other about tracking.

KEEP APART questions that differ in a way that changes the answer:
- different payment methods (credit card vs bank transfer vs Bit) are different questions;
- a general question and a narrower version of it with its own answer (minimum order vs minimum order for wholesale pricing);
- anything where merging would force one answer to cover two different facts.

RULES
- Every id you are given must appear in exactly ONE group. Do not invent ids.
- A question with no duplicate forms a group of one.
- For each group, write the clearest, most general phrasing as \`question\` and a short \`topic\`.
- Prefer FEWER, cleaner groups, but never merge two questions that need different answers.

Reply with ONLY a JSON object: {"groups":[{"ids":["..."],"question":"...","topic":"..."}]}`;

export interface DedupeResult extends StageResult {
  examined: number;
  merged: number;
  removed: number;
  finalCount: number;
}

export async function runKnowledgeDedupeStage(args: {
  tenantId: string;
  importId: string;
}): Promise<DedupeResult> {
  const { tenantId, importId } = args;
  const startedAt = Date.now();

  const candidates = await prisma.knowledgeCandidate.findMany({
    where: { tenantId, importId, status: "PENDING" },
    orderBy: { occurrenceCount: "desc" },
    select: {
      id: true,
      topic: true,
      question: true,
      answer: true,
      editedAnswer: true,
      occurrenceCount: true,
      customerCount: true,
      conflict: true,
      variants: true,
      firstSeenAt: true,
      lastSeenAt: true,
      clusterKey: true,
    },
  });

  if (candidates.length < 2) {
    await recordEvent(importId, "KNOWLEDGE_DEDUPE", "SUCCESS", "nothing to merge", {
      examined: candidates.length,
    });
    return { ok: true, examined: candidates.length, merged: 0, removed: 0, finalCount: candidates.length };
  }

  const language = await tenantPromptLanguage(tenantId);
  let merged = 0;
  let removed = 0;

  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    const listing = batch
      .map((c) => `${c.id} | ${c.topic} | ${c.question}`)
      .join("\n");

    const result = await structuredCall({
      tenantId,
      importId,
      schema: DedupeSchema,
      system: SYSTEM_PROMPT + languageDirective(language),
      user: `Candidates (id | topic | question):\n\n${listing}`,
      feature: "historical_knowledge_dedupe",
      maxTokens: 4000,
    });
    if (!result) continue;

    const byId = new Map(batch.map((c) => [c.id, c]));
    const seen = new Set<string>();

    for (const group of result.groups) {
      // Only ids we actually sent, each used once. A model that repeats an id
      // across groups would otherwise delete a candidate twice.
      const ids = group.ids.filter((id) => byId.has(id) && !seen.has(id));
      ids.forEach((id) => seen.add(id));
      if (ids.length < 2) continue;

      const members = ids.map((id) => byId.get(id)!);
      // The survivor is the one with the most evidence behind it, so the
      // merged row keeps the identity a reviewer has the best reason to trust.
      const survivor = members.reduce((a, b) => (b.occurrenceCount > a.occurrenceCount ? b : a));
      const others = members.filter((m) => m.id !== survivor.id);

      await mergeInto({ survivor, others, question: group.question, topic: group.topic, tenantId });
      merged += 1;
      removed += others.length;
    }
  }

  const finalCount = await prisma.knowledgeCandidate.count({
    where: { tenantId, importId, status: "PENDING" },
  });

  await recordEvent(
    importId,
    "KNOWLEDGE_DEDUPE",
    "SUCCESS",
    null,
    { examined: candidates.length, merged, removed, finalCount },
    Date.now() - startedAt,
  );

  return { ok: true, examined: candidates.length, merged, removed, finalCount };
}

type Member = {
  id: string;
  answer: string;
  editedAnswer: string | null;
  occurrenceCount: number;
  customerCount: number;
  conflict: boolean;
  variants: unknown;
  firstSeenAt: Date | null;
  lastSeenAt: Date | null;
};

async function mergeInto(args: {
  survivor: Member & { clusterKey: string };
  others: Member[];
  question: string;
  topic: string;
  tenantId: string;
}) {
  const { survivor, others, question, topic, tenantId } = args;
  const all = [survivor, ...others];
  const otherIds = others.map((o) => o.id);

  // Evidence moves first. If anything below fails, the worst case is evidence
  // attached to a candidate that still exists - never evidence deleted with a
  // row that was about to be removed.
  await prisma.knowledgeCandidateEvidence.updateMany({
    where: { candidateId: { in: otherIds }, tenantId },
    data: { candidateId: survivor.id },
  });

  // Distinct answers across the whole family. Two phrasings of one question
  // that got different answers is a CONFLICT the reviewer must see - merging
  // is what reveals it, and hiding it would be the worst outcome of this stage.
  const variants = mergeVariants(all);
  const conflict = variants.length > 1;

  const occurrenceCount = all.reduce((n, m) => n + m.occurrenceCount, 0);
  // Customers are a UNION, not a sum: one person who asked twice in different
  // words is one customer, and inflating this would inflate confidence.
  const customerCount = await distinctCustomerCount(survivor.id, tenantId);

  const firstSeenAt = earliest(all.map((m) => m.firstSeenAt));
  const lastSeenAt = latest(all.map((m) => m.lastSeenAt));

  await prisma.knowledgeCandidate.update({
    where: { id: survivor.id },
    data: {
      topic,
      question,
      occurrenceCount,
      customerCount,
      conflict,
      variants: variants.length > 0 ? (variants as any) : undefined,
      confidence: scoreConfidence({ occurrenceCount, customerCount, conflict }),
      firstSeenAt,
      lastSeenAt,
    },
  });

  // Their cluster vectors go too, so a later import cannot match a candidate
  // that no longer exists.
  await dropCandidateVectors(tenantId, otherIds).catch((err) =>
    console.warn("[historical-intelligence] dedupe vector cleanup failed:", err?.message ?? err),
  );
  await prisma.knowledgeCandidate.deleteMany({ where: { id: { in: otherIds }, tenantId } });
}

interface Variant {
  key: string;
  answer: string;
  occurrenceCount: number;
}

export function mergeVariants(members: Member[]): Variant[] {
  const byKey = new Map<string, Variant>();
  for (const m of members) {
    const existing = Array.isArray(m.variants) ? (m.variants as unknown[]) : [];
    const fromRow: Variant[] = existing.length
      ? existing
          .map((v) => {
            const o = v as Record<string, unknown>;
            const answer = String(o?.answer ?? "");
            return {
              key: String(o?.key ?? variantKey(answer)),
              answer,
              occurrenceCount: Number(o?.occurrenceCount ?? 1) || 1,
            };
          })
          .filter((v) => v.answer.length > 0)
      : [{ key: variantKey(m.editedAnswer ?? m.answer), answer: m.editedAnswer ?? m.answer, occurrenceCount: m.occurrenceCount || 1 }];

    for (const v of fromRow) {
      const hit = byKey.get(v.key);
      if (hit) hit.occurrenceCount += v.occurrenceCount;
      else byKey.set(v.key, { ...v });
    }
  }
  return [...byKey.values()]
    .sort((a, b) => b.occurrenceCount - a.occurrenceCount)
    .slice(0, MAX_VARIANTS);
}

/** Mirrors the extraction stage: same answer, written twice, is one variant. */
export function variantKey(answer: string): string {
  return answer
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.,;:!?"'()]/g, "")
    .trim()
    .slice(0, 120);
}

async function distinctCustomerCount(candidateId: string, tenantId: string): Promise<number> {
  const rows = await prisma.knowledgeCandidateEvidence.findMany({
    where: { candidateId, tenantId },
    select: { conversationId: true },
  });
  const ids = new Set(rows.map((r) => r.conversationId).filter(Boolean) as string[]);
  return Math.max(1, ids.size);
}

function earliest(dates: Array<Date | null>): Date | null {
  const real = dates.filter(Boolean) as Date[];
  return real.length ? new Date(Math.min(...real.map((d) => d.getTime()))) : null;
}

function latest(dates: Array<Date | null>): Date | null {
  const real = dates.filter(Boolean) as Date[];
  return real.length ? new Date(Math.max(...real.map((d) => d.getTime()))) : null;
}
