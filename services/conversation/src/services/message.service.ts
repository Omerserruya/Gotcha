import { prisma, publishEvent, type ChannelType, withHistoricalRecords } from "@chatcenter/shared";
import { getIO } from "../lib/socket";

interface CreateMessageData {
  tenantId: string;
  conversationId: string;
  direction: "INBOUND" | "OUTBOUND";
  body: string;
  messageType?: string;
  senderName?: string;
  externalMessageId?: string;
  channel?: ChannelType;
  metadata?: any;
  mediaUrl?: string;
  fileName?: string;
  /** The message this one replies to, when the agent quoted one. */
  replyToMessageId?: string;
  /**
   * The send outcome, when the caller already knows it.
   *
   * ★ THIS IS WHY 17 OF 18 WRITERS COULD NOT USE THIS FUNCTION. `create` decided
   * `status` for them - PENDING for outbound, DELIVERED for inbound - and a
   * writer that has already called the provider knows better: the flow executor
   * writes SENT or FAILED depending on whether an external id came back, and the
   * sandbox writes SENT for a message no provider ever saw.
   *
   * Omitted keeps the old behaviour exactly, so existing callers are unaffected.
   */
  status?: "PENDING" | "SENT" | "DELIVERED" | "READ" | "FAILED";
  /** The provider's own words when a send failed. */
  errorMessage?: string;
  /** The provider's id for the quoted message, when ours could not be resolved. */
  replyToExternalId?: string;
}

/**
 * Read one conversation's messages.
 *
 * Wrapped in `withHistoricalRecords` because this is asked for a conversation
 * the caller has ALREADY chosen. The live-by-default guard exists to keep
 * imported threads out of listings that decide what an agent works on - the
 * inbox, unread counts, routing - not to blank the thread after somebody
 * opens it from the History panel. Without this, an imported conversation
 * opened cleanly and showed zero messages, which reads as data loss.
 */
export async function listByConversation(tenantId: string, conversationId: string, options: { page?: number; limit?: number } = {}) {
  const page = Math.max(options.page ?? 1, 1);
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const skip = (page - 1) * limit;
  const [messages, total] = await withHistoricalRecords(() => Promise.all([
    prisma.message.findMany({
      where: { tenantId, conversationId },
      orderBy: { createdAt: "asc" },
      skip,
      take: limit,
      // The quoted message travels WITH the reply.
      //
      // Included rather than resolved client-side because the quoted message is
      // very often outside the page being rendered - somebody replying to
      // something from last week - and an inbox that shows the quote only when
      // both happen to be on screen is worse than one that never shows it: it
      // looks broken rather than absent. Four fields, not the whole row: the
      // preview needs to say who said what, and nothing else.
      include: {
        replyTo: {
          select: {
            id: true,
            body: true,
            direction: true,
            messageType: true,
            senderName: true,
            mediaUrl: true,
            fileName: true,
          },
        },
      },
    }),
    prisma.message.count({ where: { tenantId, conversationId } }),
  ]));
  return { data: messages, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

export async function create(data: CreateMessageData) {
  const message = await prisma.$transaction(async (tx) => {
    const msg = await tx.message.create({
      data: {
        tenantId: data.tenantId, conversationId: data.conversationId, direction: data.direction,
        body: data.body, messageType: data.messageType ?? "text", senderName: data.senderName,
        channel: data.channel ?? undefined,
        externalMessageId: data.externalMessageId,
        metadata: data.metadata ?? undefined,
        mediaUrl: data.mediaUrl ?? undefined,
        fileName: data.fileName ?? undefined,
        // An agent replying to one specific message. Only the local id is set
        // here; the provider's id is stamped by the outgoing worker once the
        // send returns, because it does not exist until then.
        replyToMessageId: data.replyToMessageId ?? undefined,
        replyToExternalId: data.replyToExternalId ?? undefined,
        errorMessage: data.errorMessage ?? undefined,
        // The caller's outcome when it has one, else the old default.
        status: data.status ?? (data.direction === "OUTBOUND" ? "PENDING" : "DELIVERED"),
      },
    });

    /**
     * ★ A FAILED SEND DOES NOT MOVE THE CONVERSATION'S SORT KEY.
     *
     * The inbox orders by `lastMessageAt`, and a message the customer never
     * received must not make the conversation look answered: the last real thing
     * that happened is still their inbound, and moving the column would demote a
     * customer who is still waiting on the strength of a delivery that did not
     * happen.
     *
     * This lives HERE rather than at each call site on purpose. The rule was
     * found while fixing the flow executor, and if it stayed at that one site
     * then every writer moved into this function afterwards would reintroduce the
     * bug - which is the opposite of what consolidating the writers is for.
     *
     * ─────────────────────────────────────────────────────────────────────
     * ★★ AND YET THIS RULE LIVES AT FOUR-PLUS SITES BY DECISION, NOT BY
     * OVERSIGHT. If you are here because you found it duplicated, this is the
     * choice you are looking at rather than a gap to close.
     *
     * The plan was to make this the ONE message writer. A survey of all 31
     * direct writes across 17 files found that only THREE of them - two in
     * `routes/approvals.ts` and one in `routes/contacts.ts` - can even call this
     * function. The other 28 live in `services/ai`, `incoming-worker`,
     * `outgoing-worker` and `voice-copilot`, and no service in this repo imports
     * another service's `src`. So "one writer" is not reachable from where this
     * function sits; it would require relocating it into `packages/shared`.
     *
     * That was put to the product owner as two halves - fixing the sites that
     * have the rule wrong today, against relocating the writer so the 19th
     * writer cannot get it wrong tomorrow - and the decision was to FIX THE BUGS
     * AND NOT RELOCATE. The relocation is cancelled, not deferred.
     *
     * The consequence, stated plainly so nobody has to rediscover it: the
     * failed-send rule and the origin rule are maintained BY CONVENTION at every
     * site that writes a message. The known sites carrying them correctly are
     * `incoming-worker/services/flow-executor.service.ts`,
     * `incoming-worker/services/ai-bot.service.ts` (three writes), the
     * `status === "SENT"` branch of `outgoing-worker/workers/outgoing.worker.ts`,
     * and this function. Reopening the relocation is a product decision, not a
     * cleanup - so if you are tempted, that is the conversation to have first.
     * ─────────────────────────────────────────────────────────────────────
     */
    if (msg.status !== "FAILED") {
      await tx.conversation.update({ where: { id: data.conversationId }, data: { lastMessageAt: msg.createdAt } });
    }
    return msg;
  });

  const eventData = { message, conversationId: data.conversationId };
  try { getIO().to(`tenant:${data.tenantId}`).emit("message:new", eventData); } catch {}
  publishEvent({ event: "message:new", tenantId: data.tenantId, data: eventData }).catch(() => {});
  return message;
}

export async function updateStatus(messageId: string, status: "SENT" | "DELIVERED" | "READ" | "FAILED") {
  const message = await prisma.message.findFirst({
    where: { externalMessageId: messageId },
  });
  if (!message) return null;
  const statusOrder = ["PENDING", "SENT", "DELIVERED", "READ"] as const;
  const currentIdx = statusOrder.indexOf(message.status as any);
  const newIdx = statusOrder.indexOf(status as any);
  if (status !== "FAILED" && newIdx <= currentIdx) return message;

  const updated = await prisma.message.update({ where: { id: message.id }, data: { status } });
  const eventData = { messageId: updated.id, conversationId: updated.conversationId, status: updated.status };
  try { getIO().to(`tenant:${message.tenantId}`).emit("message:status", eventData); } catch {}
  publishEvent({ event: "message:status", tenantId: message.tenantId, data: eventData }).catch(() => {});
  return updated;
}
