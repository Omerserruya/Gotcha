import { prisma, clusterKeyFor, readDurableSetting, writeDurableSetting } from "@chatcenter/shared";
import { learnAnswer } from "./knowledge-gap-answer.service";

/**
 * Answering a question from an employee's readiness report (B2, 2026-10-14).
 *
 * The report's questions are made by the model on every run and have no id,
 * so the person answers by the question's text. The answer becomes knowledge
 * exactly as an unanswered-question answer does (learnAnswer: a Q/A document
 * in the tenant-wide base, embedded before it counts), and the question is
 * remembered for this employee so the next report counts it as covered
 * instead of hoping the model asks it again.
 *
 * Remembered as TenantSetting "agent:readiness-answered:<aiAgentId>" (no
 * migration): [{question, clusterKey, documentId, answeredAt}], newest first,
 * at most MAX_ANSWERED. Answering the same question again (same clusterKey)
 * replaces its document and its entry.
 *
 * An open unanswered question with the same clusterKey (a customer asked it
 * and the AI could not answer) is resolved too: it is the same gap.
 */
export const MAX_ANSWERED = 100;
export const MAX_QUESTION = 400;

export interface AnsweredQuestion {
  question: string;
  clusterKey: string;
  documentId: string;
  answeredAt: string;
}

export function readinessAnsweredKey(aiAgentId: string): string {
  return `agent:readiness-answered:${aiAgentId}`;
}

export async function readAnsweredQuestions(tenantId: string, aiAgentId: string): Promise<AnsweredQuestion[]> {
  try {
    const raw = await readDurableSetting(tenantId, readinessAnsweredKey(aiAgentId));
    if (!raw) return [];
    const v = JSON.parse(raw);
    return Array.isArray(v)
      ? v.filter((a: any) => a && typeof a.question === "string" && typeof a.clusterKey === "string" && typeof a.documentId === "string")
      : [];
  } catch {
    return [];
  }
}

export class ReadinessAnswerError extends Error {
  constructor(public status: number, public code: "AGENT_NOT_FOUND") {
    super(code);
  }
}

export async function answerReadinessQuestion(input: {
  tenantId: string;
  userId: string;
  aiAgentId: string;
  question: string;
  answer: string;
}): Promise<{ documentId: string; knowledgeBaseId: string; resolvedAt: Date; resolvedUnansweredQuestionId: string | null }> {
  const { tenantId, userId, aiAgentId } = input;
  const agent = await prisma.aIAgent.findFirst({ where: { id: aiAgentId, tenantId }, select: { id: true } });
  if (!agent) throw new ReadinessAnswerError(404, "AGENT_NOT_FOUND");

  const question = input.question.trim();
  const clusterKey = clusterKeyFor(question);
  // Throws NOT_LEARNED (502) before anything below is recorded.
  const { documentId, knowledgeBaseId } = await learnAnswer({
    tenantId,
    question,
    answer: input.answer,
    dedupeKey: `readiness_question:${aiAgentId}:${clusterKey}`,
    metadata: { origin: "readiness_question", aiAgentId, answeredBy: userId },
  });

  const resolvedAt = new Date();
  const answered = await readAnsweredQuestions(tenantId, aiAgentId);
  const next: AnsweredQuestion[] = [
    { question, clusterKey, documentId, answeredAt: resolvedAt.toISOString() },
    ...answered.filter((a) => a.clusterKey !== clusterKey),
  ].slice(0, MAX_ANSWERED);
  await writeDurableSetting(tenantId, readinessAnsweredKey(aiAgentId), JSON.stringify(next), "readiness");

  const gap = await prisma.unansweredQuestion.findFirst({
    where: { tenantId, clusterKey, resolvedAt: null },
    select: { id: true },
  });
  if (gap) await prisma.unansweredQuestion.update({ where: { id: gap.id }, data: { resolvedAt } });

  return { documentId, knowledgeBaseId, resolvedAt, resolvedUnansweredQuestionId: gap?.id ?? null };
}
