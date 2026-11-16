/**
 * Turning the routing automation off stops the AI on the open conversations it
 * already owns (Omer 2026-11-16; prod Alea Design: a conversation routed to the
 * AI at 09:55 kept getting AI replies after its "Who answers new conversations"
 * flow was turned off at 10:09, because the assignment sticks to the row).
 *
 * Checked per turn in processAIBot, the one door both reply engines go
 * through, so it holds however the flow was turned off (pause, edit, the
 * employee's channels toggle, SQL) and for conversations routed before this
 * check existed.
 *
 * Withdrawn when ALL hold:
 *   - the conversation is open, assigned to an AI employee, and no person owns it;
 *   - the latest automation step that routed it (route_target / default_fallback)
 *     sent it to an AI employee, that same employee (a later assignment by any
 *     other path is never overridden);
 *   - that step's automation is no longer active.
 * Then the conversation is released in place: still OPEN, unassigned, in the
 * inbox for a person, with one ai.routing_withdrawn audit row.
 */
import { prisma, publishEvent } from "@chatcenter/shared";

export interface WithdrawnRouting {
  flowId: string;
  flowName: string | null;
  aiAgentId: string;
}

const ROUTE_NODES = ["route_target", "default_fallback"];

export async function routingWithdrawn(
  conversation: { id: string; tenantId: string; status?: string | null; assignedAiAgentId?: string | null; assignedAgentId?: string | null; isHandedOver?: boolean | null },
  db: any = prisma,
): Promise<WithdrawnRouting | null> {
  if (!conversation.assignedAiAgentId) return null;
  if (conversation.assignedAgentId || conversation.isHandedOver) return null;
  if (String(conversation.status ?? "").toUpperCase() === "CLOSED") return null;
  let step: any = null;
  try {
    step = await db.automationRunStep?.findFirst?.({
      where: { tenantId: conversation.tenantId, nodeType: { in: ROUTE_NODES }, run: { conversationId: conversation.id, tenantId: conversation.tenantId } },
      orderBy: { at: "desc" },
      select: { output: true, run: { select: { flowId: true, flow: { select: { isActive: true, name: true } } } } },
    });
  } catch {
    // Unreadable: the AI keeps the conversation (this check only ever withdraws on proof).
    return null;
  }
  if (!step?.run) return null;
  const out = (step.output ?? {}) as { routeType?: string; targetId?: string | null };
  if ((out.routeType ?? "agent") !== "agent") return null;
  if (out.targetId && out.targetId !== conversation.assignedAiAgentId) return null;
  if (step.run.flow?.isActive !== false) return null;
  return { flowId: step.run.flowId, flowName: step.run.flow?.name ?? null, aiAgentId: conversation.assignedAiAgentId };
}

/** Release in place: open, unassigned, visible. Only if still held by that same AI employee. */
export async function releaseWithdrawnRouting(
  tenantId: string,
  conversationId: string,
  w: WithdrawnRouting,
  db: any = prisma,
): Promise<boolean> {
  const { count } = await db.conversation.updateMany({
    where: { id: conversationId, tenantId, assignedAiAgentId: w.aiAgentId, assignedAgentId: null },
    data: { assignedAiAgentId: null, handledBy: null },
  });
  if (!count) return false;
  await db.auditLog.create({
    data: {
      tenantId,
      actorType: "system",
      action: "ai.routing_withdrawn",
      targetType: "conversation",
      targetId: conversationId,
      metadata: { flowId: w.flowId, flowName: w.flowName, aiAgentId: w.aiAgentId, reason: "routing_automation_inactive" },
    },
  }).catch((e: any) => console.warn("[routing-withdrawn] audit failed:", e?.message));
  publishEvent?.({ event: "conversation:updated", tenantId, data: { id: conversationId, assignedAiAgentId: null, handledBy: null } } as any).catch(() => {});
  return true;
}
