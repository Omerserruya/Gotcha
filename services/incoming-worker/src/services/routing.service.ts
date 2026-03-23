import { prisma, analyticsQueue, publishEvent } from "@chatcenter/shared";
import { processAIBot } from "./ai-bot.service";
import { processChatbotFlow } from "./chatbot-engine.service";

export interface RoutingResult {
  departmentId: string | null;
  assignedAgentId: string | null;
  handledByAI: boolean;
  intent: string;
  matchedRule: string | null;
}

// ─── AI-powered intent classification via AI service ─────────
const AI_SERVICE_URL = process.env.AI_SERVICE_URL || "http://ai:4006";

// Ask AI service if a message matches a specific intent (true/false)
async function checkIntentAI(message: string, intent: string): Promise<boolean> {
  try {
    const res = await fetch(`${AI_SERVICE_URL}/api/ai-assist/intent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Key": process.env.INTERNAL_SERVICE_KEY || "chatcenter-internal-2026",
      },
      body: JSON.stringify({ message, intent }),
    });
    if (!res.ok) throw new Error(`AI intent responded ${res.status}`);
    const json = await res.json() as any;
    return json.data?.match === true;
  } catch (err) {
    console.warn("[routing] AI intent check failed:", (err as Error).message);
    return false;
  }
}

// ─── Legacy intent classification (fallback when no AI provider) ──
function classifyIntentLocally(message: string): { intent: string; department: string | null } {
  const lower = message.toLowerCase();
  if (/\b(price|pricing|buy|purchase|plan|upgrade|demo|trial|quote)\b/.test(lower))
    return { intent: "sales_inquiry", department: "Sales" };
  if (/\b(invoice|bill|payment|charge|refund|subscription|cancel.*plan)\b/.test(lower))
    return { intent: "billing", department: "Billing" };
  if (/\b(bug|error|broken|crash|not working|issue|problem|fix|debug)\b/.test(lower))
    return { intent: "technical_support", department: "Support" };
  if (/\b(return|ship|deliver|track|order|package)\b/.test(lower))
    return { intent: "order_inquiry", department: "Support" };
  return { intent: "general", department: null };
}

// ─── Condition evaluator for router rules ────────────────────
interface RuleCondition {
  type: "intent" | "keyword" | "channel" | "tag";
  operator: "equals" | "contains" | "is_not";
  value: string;
}

function evaluateCondition(
  condition: RuleCondition,
  context: { message: string; intent: string; channel: string; tags: string[] }
): boolean {
  const { type, operator, value } = condition;
  const lowerValue = value.toLowerCase();

  switch (type) {
    case "intent": {
      const intentMatch = context.intent.toLowerCase();
      if (operator === "equals") return intentMatch === lowerValue || intentMatch.includes(lowerValue);
      if (operator === "contains") return intentMatch.includes(lowerValue);
      if (operator === "is_not") return intentMatch !== lowerValue && !intentMatch.includes(lowerValue);
      return false;
    }
    case "keyword": {
      const lowerMsg = context.message.toLowerCase();
      if (operator === "equals") return lowerMsg === lowerValue;
      if (operator === "contains") return lowerMsg.includes(lowerValue);
      if (operator === "is_not") return !lowerMsg.includes(lowerValue);
      return false;
    }
    case "channel": {
      const ch = context.channel.toLowerCase();
      if (operator === "equals") return ch === lowerValue;
      if (operator === "is_not") return ch !== lowerValue;
      return ch === lowerValue;
    }
    case "tag": {
      const hasTag = context.tags.some(t => t.toLowerCase() === lowerValue);
      if (operator === "equals" || operator === "contains") return hasTag;
      if (operator === "is_not") return !hasTag;
      return false;
    }
    default:
      return false;
  }
}

function evaluateRule(
  conditions: RuleCondition[],
  logic: string,
  context: { message: string; intent: string; channel: string; tags: string[] }
): boolean {
  if (!conditions || conditions.length === 0) return true; // No conditions = always match (e.g., default rule)

  if (logic === "OR") {
    return conditions.some(c => evaluateCondition(c, context));
  }
  // AND (default)
  return conditions.every(c => evaluateCondition(c, context));
}

// ─── Agent assignment helpers ────────────────────────────────
export async function assignToLeastBusyAgent(tenantId: string, departmentId: string): Promise<string | null> {
  const members = await prisma.departmentMember.findMany({
    where: { tenantId, departmentId },
    select: { userId: true },
  });

  if (members.length === 0) return null;

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

  counts.sort((a, b) => a.count - b.count);
  return counts[0]?.userId ?? null;
}

// ─── Main routing function ───────────────────────────────────
export async function routeConversation(
  tenantId: string,
  conversationId: string,
  message: string,
  channel?: string
): Promise<RoutingResult> {
  const result: RoutingResult = {
    departmentId: null,
    assignedAgentId: null,
    handledByAI: false,
    intent: "general",
    matchedRule: null,
  };

  // Step 1: Load router rules (default rules always last)
  const allRules = await prisma.routerRule.findMany({
    where: { tenantId, enabled: true },
    orderBy: { priority: "asc" },
  });
  const rules = [
    ...allRules.filter(r => !r.isDefault),
    ...allRules.filter(r => r.isDefault),
  ];

  // Step 2: Evaluate rules — use AI only for intent conditions
  const { intent: localIntent } = classifyIntentLocally(message);
  result.intent = localIntent;

  if (rules.length > 0) {
    const context = {
      message,
      intent: localIntent,
      channel: channel || "whatsapp",
      tags: [] as string[],
    };

    for (const rule of rules) {
      const conditions = (rule.conditions as unknown as RuleCondition[]) || [];
      const isDefault = rule.isDefault;
      console.log(`[routing] evaluating rule=${rule.id} name=${rule.name} isDefault=${isDefault} conditions=${JSON.stringify(conditions)}`);

      // For each intent condition, call AI to check true/false
      let matched = false;
      if (isDefault) {
        matched = true;
      } else if (conditions.length === 0) {
        matched = true;
      } else {
        const results: boolean[] = [];
        for (const cond of conditions) {
          if (cond.type === "intent") {
            // Call AI: does this message match this intent?
            const aiMatch = await checkIntentAI(message, cond.value);
            const condResult = cond.operator === "is_not" ? !aiMatch : aiMatch;
            results.push(condResult);
            if (aiMatch) result.intent = cond.value; // update intent to matched value
          } else {
            // Evaluate keyword/channel/tag locally
            results.push(evaluateCondition(cond, context));
          }
        }
        matched = rule.logic === "OR"
          ? results.some(r => r)
          : results.every(r => r);
      }

      if (matched) {
        result.matchedRule = rule.id;

        switch (rule.routeType) {
          case "AI_AGENT": {
            // Route to AI Agent — handle autonomously
            if (rule.aiAgentId) {
              result.handledByAI = true;
              await processAIBot(tenantId, conversationId, message);
            }
            break;
          }
          case "FLOW": {
            // Route to a chatbot flow (sub-playbook)
            if (rule.routeTarget) {
              const flow = await prisma.chatbotFlow.findFirst({
                where: { id: rule.routeTarget, tenantId, isActive: true },
              });
              if (flow) {
                await prisma.conversation.update({
                  where: { id: conversationId },
                  data: { chatbotFlowId: flow.id, chatbotNodeId: null },
                });
                // Increment flow run count
                await prisma.chatbotFlow.update({
                  where: { id: flow.id },
                  data: { runCount: { increment: 1 } },
                });
                // Actually execute the flow for this first message
                await processChatbotFlow(tenantId, conversationId, message);
                result.handledByAI = true;
              }
            }
            break;
          }
          case "DEPARTMENT": {
            // Route to a department
            if (rule.routeTarget) {
              const dept = await prisma.department.findFirst({
                where: { id: rule.routeTarget, tenantId, isActive: true },
                select: { id: true, queueMode: true, autoRepliesEnabled: true, aiSuggestionsEnabled: true },
              });
              if (dept) {
                result.departmentId = dept.id;
                await prisma.conversation.update({
                  where: { id: conversationId },
                  data: { departmentId: dept.id },
                });
                if (dept.autoRepliesEnabled) {
                  result.handledByAI = true;
                  await processAIBot(tenantId, conversationId, message);
                } else {
                  await prisma.conversation.update({
                    where: { id: conversationId },
                    data: { status: "WAITING" },
                  });
                  if (dept.queueMode === "ROUND_ROBIN") {
                    const agentId = await assignToLeastBusyAgent(tenantId, dept.id);
                    if (agentId) {
                      result.assignedAgentId = agentId;
                      await prisma.conversation.update({
                        where: { id: conversationId },
                        data: { assignedAgentId: agentId },
                      });
                    }
                  }
                }
              }
            }
            break;
          }
          case "HUMAN": {
            // Route to human agent queue
            await prisma.conversation.update({
              where: { id: conversationId },
              data: { status: "WAITING" },
            });
            break;
          }
        }

        // First match wins — stop evaluating
        break;
      }
    }
  } else {
    // ─── Legacy fallback: no router rules configured ───────────
    const { department: departmentName } = classifyIntentLocally(message);

    let department: { id: string; queueMode: string; autoRepliesEnabled: boolean; aiSuggestionsEnabled: boolean } | null = null;

    if (departmentName) {
      department = await prisma.department.findFirst({
        where: { tenantId, name: { equals: departmentName, mode: "insensitive" }, isActive: true },
        select: { id: true, queueMode: true, autoRepliesEnabled: true, aiSuggestionsEnabled: true },
      });
    }

    if (department) {
      result.departmentId = department.id;
      await prisma.conversation.update({
        where: { id: conversationId },
        data: { departmentId: department.id },
      });

      if (department.autoRepliesEnabled) {
        result.handledByAI = true;
        await processAIBot(tenantId, conversationId, message);
      } else {
        await prisma.conversation.update({
          where: { id: conversationId },
          data: { status: "WAITING" },
        });
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
      }
    }
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
      matchedRule: result.matchedRule,
    },
    timestamp: new Date().toISOString(),
  });

  console.log(`[routing] conversation=${conversationId} intent=${result.intent} rule=${result.matchedRule} dept=${result.departmentId} agent=${result.assignedAgentId} ai=${result.handledByAI}`);

  return result;
}
