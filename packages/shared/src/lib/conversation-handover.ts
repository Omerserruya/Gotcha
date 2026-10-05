/**
 * Recording who took a conversation over, and when.
 *
 * `Conversation.handledBy` is a single string. It says who is driving NOW and
 * nothing else: not when that changed, not what it changed from, not how many
 * times. So "last handover 3 hours ago" could not be derived, and neither could
 * the more useful question underneath it - how often the AI gives up, and on
 * what.
 *
 * Every meaningful transition goes through here rather than through a bare
 * `prisma.conversation.update`, so the column and the history cannot disagree.
 * They are written in ONE transaction for the same reason: a history that is
 * sometimes missing a row is not a history, it is a rumour.
 */
import { prisma } from "./prisma";

/** The handlers that actually drive a conversation. */
export const CONVERSATION_HANDLERS = ["ai_agent", "flow", "human"] as const;
export type ConversationHandler = (typeof CONVERSATION_HANDLERS)[number];

/** Why the handler changed, as a code the frontend translates. */
export type HandoverReason = "escalation" | "takeover" | "assignment" | "routing" | "return_to_ai" | "ai_stopped";

export interface RecordHandoverInput {
  tenantId: string;
  conversationId: string;
  to: ConversationHandler;
  /** The membership that took over, when a person did. */
  actorUserId?: string | null;
  reason?: HandoverReason;
  /** Extra columns to set on the same update - `status`, `isHandedOver`, etc. */
  data?: Record<string, unknown>;
}

/**
 * Move a conversation to a new handler, and record the move.
 *
 * Returns the history row, or null when nothing changed.
 *
 * THE NO-OP CASE IS THE IMPORTANT ONE. A flow executor sets `handledBy: "flow"`
 * on every node it walks through, and an approval resume sets `"ai_agent"`
 * whether or not anything moved. Writing a row for those would report a
 * conversation as having been handed over eleven times when it was handed over
 * once, and "last handover 3 hours ago" would mean "the bot advanced a step".
 * A handover is a CHANGE of handler; this is where that is decided, once,
 * rather than at each of the dozen call sites.
 *
 * Transient states (`awaiting_approval`, `sandbox`) are not handlers and are
 * not routed through here - they are a pause in what the current handler is
 * doing, not somebody else taking the wheel.
 */
export async function recordHandover(
  input: RecordHandoverInput,
): Promise<{ id: string; from: string | null; to: string; at: Date } | null> {
  const { tenantId, conversationId, to, actorUserId, reason, data } = input;

  return prisma.$transaction(async (tx) => {
    const current = await tx.conversation.findFirst({
      where: { id: conversationId, tenantId },
      select: { handledBy: true },
    });
    // A conversation that is not there, or not this tenant's, is not an error
    // worth failing a takeover over - but it is certainly not a handover.
    if (!current) return null;

    const from = current.handledBy;
    if (from === to) {
      // Still apply the caller's other columns: a takeover that also sets
      // `status` must not be dropped just because the handler already matched.
      if (data && Object.keys(data).length > 0) {
        await tx.conversation.update({ where: { id: conversationId }, data: data as never });
      }
      return null;
    }

    await tx.conversation.update({
      where: { id: conversationId },
      data: { ...(data ?? {}), handledBy: to } as never,
    });

    const row = await tx.conversationHandover.create({
      data: {
        tenantId,
        conversationId,
        fromHandler: from,
        toHandler: to,
        actorUserId: actorUserId ?? null,
        reason: reason ?? null,
      },
      select: { id: true, fromHandler: true, toHandler: true, at: true },
    });
    return { id: row.id, from: row.fromHandler, to: row.toHandler, at: row.at };
  });
}

/**
 * The tenant's most recent handover, or null when none has been recorded.
 *
 * Null is not "no handovers have ever happened" - it is "none since this
 * started being recorded". The card must render that as absence, never as
 * zero, because a freshly deployed tenant and a tenant whose AI has never
 * needed help are not the same thing and should not read the same.
 */
export async function latestHandover(
  tenantId: string,
): Promise<{ at: string; from: string | null; to: string } | null> {
  const row = await prisma.conversationHandover.findFirst({
    where: { tenantId },
    orderBy: { at: "desc" },
    select: { at: true, fromHandler: true, toHandler: true },
  });
  if (!row) return null;
  return { at: row.at.toISOString(), from: row.fromHandler, to: row.toHandler };
}
