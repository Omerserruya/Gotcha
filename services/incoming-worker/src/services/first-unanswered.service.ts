/**
 * Is this the conversation's first message that should be routed (the
 * playbook decides who answers it)?
 *
 * The first message of a conversation, or - while it is still unowned - the
 * first one after replies that were not an answer: an automation's, or the
 * system's own (a "הסר" opt-out confirmation, the unsupported-media notice).
 * Without the second rule a visitor who opened with "הסר" or a sticker and
 * then asked a question got no answer at all: the message count was past 1,
 * so routing never ran, and nobody owned the conversation.
 */
import { prisma } from "@chatcenter/shared";

export async function isFirstUnanswered(
  tenantId: string,
  conversation: { id: string; handledBy?: string | null; assignedAiAgentId?: string | null; chatbotNodeId?: string | null; automationRunId?: string | null },
  automationAnsweredBefore: (tenantId: string, conversationId: string) => Promise<boolean>,
): Promise<boolean> {
  const messageCount = await prisma.message.count({ where: { conversationId: conversation.id } });
  if (messageCount <= 1) return true;
  const unowned = !conversation.handledBy && !conversation.assignedAiAgentId && !conversation.chatbotNodeId && !conversation.automationRunId;
  if (!unowned) return false;
  if (await automationAnsweredBefore(tenantId, conversation.id)) return true;
  // Only the system has replied so far (senderName "System"; null is a reply too).
  const answers = await prisma.message.count({
    where: {
      conversationId: conversation.id,
      direction: "OUTBOUND",
      OR: [{ senderName: null }, { senderName: { not: "System" } }],
    } as any,
  });
  return answers === 0;
}
