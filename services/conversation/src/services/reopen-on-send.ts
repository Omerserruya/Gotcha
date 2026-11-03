/**
 * A person writing into a CLOSED conversation reopens it (Omer, 2026-11-03).
 *
 * The worker never reopens a closed conversation on an inbound message (stale
 * assignment, handoff, bot state), so an agent's "היי" into a closed thread
 * used to stay there, and the customer's reply opened a NEW conversation the
 * bot took and the agent never saw. Now the person's send reopens it, takes
 * it (when nobody had it) and stops the bot; the reply finds it open.
 *
 * Only a signed-in person: not the system (internal key), and support mode
 * reopens without assigning the hidden support actor.
 */
import type { Prisma } from "@prisma/client";
import { prisma, publishEvent } from "@chatcenter/shared";
import { getIO } from "../lib/socket";

export interface SendingPrincipal { userId?: string; isInternal?: boolean; support?: unknown }

export function reopenOnSend(
  conversation: { status: string; assignedAgentId: string | null },
  user: SendingPrincipal | undefined | null,
): Prisma.ConversationUncheckedUpdateInput | null {
  if (conversation.status !== "CLOSED") return null;
  if (!user?.userId || user.isInternal || user.userId === "system") return null;
  return {
    status: "OPEN",
    closedAt: null,
    archivedAt: null,
    // A person drives it now: the same latch a takeover sets, so no bot answers the reply.
    handledBy: "human",
    isHandedOver: true,
    chatbotNodeId: null,
    chatbotFlowId: null,
    automationRunId: null,
    ...(conversation.assignedAgentId || user.support ? {} : { assignedAgentId: user.userId }),
  };
}

/**
 * Apply the reopen and tell every inbox, the way claim/release/close do
 * (conversation.service emitToTenant): conversation:updated with the full row
 * and its assignee, to the tenant room and the event bus. Without it the
 * sender and everyone else still see it closed until a refresh.
 */
export async function applyReopenOnSend(tenantId: string, conversationId: string, data: Prisma.ConversationUncheckedUpdateInput) {
  const updated = await prisma.conversation.update({
    where: { id: conversationId },
    data,
    include: { assignedAgent: { select: { id: true, name: true, email: true } } },
  });
  try { getIO()?.to(`tenant:${tenantId}`).emit("conversation:updated", updated); } catch { /* socket not ready */ }
  publishEvent({ event: "conversation:updated", tenantId, data: updated }).catch(() => {});
  return updated;
}
