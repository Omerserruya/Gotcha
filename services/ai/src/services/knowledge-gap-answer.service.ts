/**
 * Answer a question customers asked that the AI could not (design 08): the
 * owner's answer becomes knowledge, and the question stops surfacing.
 *
 * - The answer is stored as a question-and-answer document, the shape the
 *   onboarding /teach route writes ("**question**\n\nanswer"), in the first
 *   ACTIVE, tenant-wide (scope "all") knowledge base: retrieval reads only
 *   active ones, and a base scoped to one agent or department is invisible
 *   to every other employee (knowledge.service readableKnowledgeBaseIds).
 * - One document per question (`unanswered_question:<id>`): answering again
 *   REPLACES it and drops its old vectors, so the AI can never quote the
 *   answer the owner just corrected.
 * - Resolved only once learned: the embedding is awaited, and a document that
 *   did not embed leaves the question open (NOT_LEARNED), because "answered"
 *   that the AI cannot retrieve is a false success.
 * - The answer is the owner's text and is kept exactly as written.
 *
 * A question asked again that the AI still cannot answer is reopened by the
 * gap writer (packages/shared knowledge-gaps.ts): a bad answer resurfaces.
 */
import { prisma } from "@chatcenter/shared";
import { processDocument } from "./embedding.service";
import { deleteByDocumentId } from "./qdrant.service";

export const MAX_ANSWER = 20000;

export class GapAnswerError extends Error {
  constructor(public status: number, public code: "QUESTION_NOT_FOUND" | "NOT_LEARNED") {
    super(code);
  }
}

export async function answerUnansweredQuestion(input: {
  tenantId: string;
  userId: string;
  questionId: string;
  answer: string;
}): Promise<{ resolvedAt: Date; documentId: string; resolvedBy: string }> {
  const { tenantId, userId } = input;
  // Tenant-scoped on the WHERE: another workspace's id simply does not exist.
  const q = await prisma.unansweredQuestion.findFirst({
    where: { id: input.questionId, tenantId },
    select: { id: true, question: true },
  });
  if (!q) throw new GapAnswerError(404, "QUESTION_NOT_FOUND");

  const { documentId } = await learnAnswer({
    tenantId,
    question: q.question,
    answer: input.answer,
    dedupeKey: `unanswered_question:${q.id}`,
    // UnansweredQuestion has no resolvedBy column (a migration); who answered
    // travels with the knowledge it produced.
    metadata: { origin: "unanswered_question", unansweredQuestionId: q.id, answeredBy: userId },
  });

  const resolvedAt = new Date();
  await prisma.unansweredQuestion.update({ where: { id: q.id }, data: { resolvedAt } });
  return { resolvedAt, documentId, resolvedBy: userId };
}

/**
 * Store an owner's answer to a question as knowledge the AI can retrieve: one
 * "**question**\n\nanswer" document per dedupeKey in the first ACTIVE,
 * tenant-wide (scope "all") base, created if there is none. Answering again
 * replaces the document and drops its old vectors. Resolves only once
 * embedded; a document that did not embed throws NOT_LEARNED.
 * Shared by the gap answer above and the readiness-question answer.
 */
export async function learnAnswer(input: {
  tenantId: string;
  question: string;
  answer: string;
  dedupeKey: string;
  metadata: Record<string, unknown>;
}): Promise<{ documentId: string; knowledgeBaseId: string }> {
  const { tenantId, dedupeKey } = input;
  const title = input.question.trim().slice(0, 200);
  const content = `**${input.question.trim()}**\n\n${input.answer}`;
  const metadata = { ...input.metadata, dedupeKey, answeredAt: new Date().toISOString() };

  const existing = await prisma.knowledgeDocument.findFirst({
    where: { tenantId, metadata: { path: ["dedupeKey"], equals: dedupeKey } },
    select: { id: true, metadata: true, knowledgeBaseId: true },
  });

  let documentId: string;
  let knowledgeBaseId: string;
  if (existing) {
    const prior = existing.metadata && typeof existing.metadata === "object" && !Array.isArray(existing.metadata) ? (existing.metadata as Record<string, unknown>) : {};
    await prisma.knowledgeDocument.update({
      where: { id: existing.id },
      data: { title, content, metadata: { ...prior, ...metadata }, status: "pending" },
    });
    // The superseded answer's vectors go first, or retrieval keeps quoting it.
    await deleteByDocumentId(existing.id);
    documentId = existing.id;
    knowledgeBaseId = existing.knowledgeBaseId;
  } else {
    const kb =
      (await prisma.knowledgeBase.findFirst({ where: { tenantId, isActive: true, scope: "all" }, orderBy: { createdAt: "asc" }, select: { id: true } })) ??
      (await prisma.knowledgeBase.create({ data: { tenantId, name: "Company Knowledge", description: "Answers to customer questions" }, select: { id: true } }));
    const doc = await prisma.knowledgeDocument.create({
      data: { knowledgeBaseId: kb.id, tenantId, title, content, sourceType: "text", metadata, status: "pending" },
      select: { id: true },
    });
    documentId = doc.id;
    knowledgeBaseId = kb.id;
  }

  try {
    await processDocument(documentId);
  } catch (err: any) {
    console.error(`[knowledge-gap-answer] ${documentId} did not embed:`, err?.message);
    throw new GapAnswerError(502, "NOT_LEARNED");
  }
  return { documentId, knowledgeBaseId };
}
