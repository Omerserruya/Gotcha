import { prisma, analyticsQueue, publishEvent } from "@chatcenter/shared";
import { processAIBot } from "./ai-bot.service";

export interface RoutingResult {
  departmentId: string | null;
  assignedAgentId: string | null;
  handledByAI: boolean;
  intent: string;
}

function classifyIntentLocally(message: string): { intent: string; department: string | null } {
  const lower = message.toLowerCase();
  // Sales signals
  if (/\b(price|pricing|buy|purchase|plan|upgrade|demo|trial|quote)\b/.test(lower))
    return { intent: "sales_inquiry", department: "Sales" };
  // Billing
  if (/\b(invoice|bill|payment|charge|refund|subscription|cancel.*plan)\b/.test(lower))
    return { intent: "billing", department: "Billing" };
  // Technical
  if (/\b(bug|error|broken|crash|not working|issue|problem|fix|debug)\b/.test(lower))
    return { intent: "technical_support", department: "Support" };
  // Returns/shipping
  if (/\b(return|ship|deliver|track|order|package)\b/.test(lower))
    return { intent: "order_inquiry", department: "Support" };
  // General
  return { intent: "general", department: null };
}

export async function assignToLeastBusyAgent(tenantId: string, departmentId: string): Promise<string | null> {
  // Find all active members of the department
  const members = await prisma.departmentMember.findMany({
    where: { tenantId, departmentId },
    select: { userId: true },
  });

  if (members.length === 0) return null;

  // For each member, count their open conversations
  const counts = await Promise.all(
    members.map(async (m) => {
      const count = await prisma.conversation.count({
        where: {
          tenantId,
          assignedAgentId: m.userId,
          status: { in: ["OPEN", "WAITING"] },
        },
      });
      return { userId: m.userId, count };
    })
  );

  // Return the agent with fewest active conversations
  counts.sort((a, b) => a.count - b.count);
  return counts[0]?.userId ?? null;
}

export async function routeConversation(
  tenantId: string,
  conversationId: string,
  message: string
): Promise<RoutingResult> {
  const result: RoutingResult = {
    departmentId: null,
    assignedAgentId: null,
    handledByAI: false,
    intent: "general",
  };

  // Step 1: Intent classification
  const { intent, department: departmentName } = classifyIntentLocally(message);
  result.intent = intent;

  // Step 2: Find matching department
  let department: { id: string; queueMode: string; autoRepliesEnabled: boolean; aiSuggestionsEnabled: boolean } | null = null;

  if (departmentName) {
    department = await prisma.department.findFirst({
      where: {
        tenantId,
        name: { equals: departmentName, mode: "insensitive" },
        isActive: true,
      },
      select: {
        id: true,
        queueMode: true,
        autoRepliesEnabled: true,
        aiSuggestionsEnabled: true,
      },
    });
  }

  if (department) {
    result.departmentId = department.id;

    // Assign conversation to department
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { departmentId: department.id },
    });

    // Step 3: Check department AI settings
    if (department.autoRepliesEnabled) {
      // AI bot handles it autonomously
      result.handledByAI = true;
      await processAIBot(tenantId, conversationId, message);
    } else {
      // Mark as WAITING for human (with or without AI copilot)
      await prisma.conversation.update({
        where: { id: conversationId },
        data: { status: "WAITING" },
      });

      // Step 4: Agent assignment (Round Robin)
      if (department.queueMode === "ROUND_ROBIN") {
        const agentId = await assignToLeastBusyAgent(tenantId, department.id);
        if (agentId) {
          result.assignedAgentId = agentId;
          await prisma.conversation.update({
            where: { id: conversationId },
            data: { assignedAgentId: agentId },
          });
        }
      }
      // CLAIM mode: leave unassigned, agents claim from queue
    }
  } else {
    // No matching department - leave unassigned, goes to default queue
    // status remains OPEN for chatbot/human to handle
  }

  // Publish updated conversation state
  await publishEvent({
    event: "conversation:updated",
    tenantId,
    data: { id: conversationId, departmentId: result.departmentId, assignedAgentId: result.assignedAgentId },
  });

  // Queue analytics event
  await analyticsQueue.add("routing-applied", {
    tenantId,
    event: "conversation_routed",
    data: {
      conversationId,
      intent: result.intent,
      departmentId: result.departmentId,
      assignedAgentId: result.assignedAgentId,
      handledByAI: result.handledByAI,
    },
    timestamp: new Date().toISOString(),
  });

  console.log(`[routing] conversation=${conversationId} intent=${result.intent} dept=${result.departmentId} agent=${result.assignedAgentId} ai=${result.handledByAI}`);

  return result;
}
