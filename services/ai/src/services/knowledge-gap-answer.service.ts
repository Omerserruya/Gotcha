/**
 * Answer a question customers asked that the AI could not (design 08): the
 * owner's answer becomes knowledge, and the question stops surfacing.
 *
 * - The answer is stored as a question-and-answer document, the shape the
 *   onboarding /teach route writes ("**question**\n\nanswer"), in the first
 *   ACTIVE knowledge base: retrieval reads only active ones.
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

  const dedupeKey = `unanswered_question:${q.id}`;
  const title = q.question.trim().slice(0, 200);
  const content = `**${q.question.trim()}**\n\n${input.answer}`;
  // UnansweredQuestion has no resolvedBy column (a migration); who answered
  // travels with the knowledge it produced.
  const metadata = { origin: "unanswered_question", dedupeKey, unansweredQuestionId: q.id, answeredBy: userId, answeredAt: new Date().toISOString() };

  const existing = await prisma.knowledgeDocument.findFirst({
    where: { tenantId, metadata: { path: ["dedupeKey"], equals: dedupeKey } },
    select: { id: true, metadata: true },
  });

  let documentId: string;
  if (existing) {
    const prior = existing.metadata && typeof existing.metadata === "object" && !Array.isArray(existing.metadata) ? (existing.metadata as Record<string, unknown>) : {};
    await prisma.knowledgeDocument.update({
      where: { id: existing.id },
      data: { title, content, metadata: { ...prior, ...metadata }, status: "pending" },
    });
    // The superseded answer's vectors go first, or retrieval keeps quoting it.
    await deleteByDocumentId(existing.id);
    documentId = existing.id;
  } else {
    const kb =
      (await prisma.knowledgeBase.findFirst({ where: { tenantId, isActive: true }, orderBy: { createdAt: "asc" }, select: { id: true } })) ??
      (await prisma.knowledgeBase.create({ data: { tenantId, name: "Company Knowledge", description: "Answers to customer questions" }, select: { id: true } }));
    const doc = await prisma.knowledgeDocument.create({
      data: { knowledgeBaseId: kb.id, tenantId, title, content, sourceType: "text", metadata, status: "pending" },
      select: { id: true },
    });
    documentId = doc.id;
  }

  try {
    await processDocument(documentId);
  } catch (err: any) {
    console.error(`[knowledge-gap-answer] ${documentId} did not embed:`, err?.message);
    throw new GapAnswerError(502, "NOT_LEARNED");
  }

  const resolvedAt = new Date();
  await prisma.unansweredQuestion.update({ where: { id: q.id }, data: { resolvedAt } });
  return { resolvedAt, documentId, resolvedBy: userId };
}
