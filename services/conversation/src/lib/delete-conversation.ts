/**
 * Deleting one conversation (the inbox's swipe to delete, 2026-11-22).
 *
 * What the database does by itself when a conversation row goes
 * (packages/shared/prisma/schema.prisma, every rule is CASCADE or SET NULL,
 * none is RESTRICT, so the delete cannot fail on a foreign key):
 *   - deleted with it: messages, conversation_states, conversation_read_states,
 *     conversation_intelligence, voice_call_sessions (and their participants,
 *     post-processing rows and action items), call_analyses (and their QA
 *     scores), conversation_handovers;
 *   - detached (SET NULL): historical_customers.conversation_id, and
 *     messages.reply_to_message_id of any message that quoted a deleted one.
 *
 * What this adds:
 *   - a message still waiting to be sent in this conversation (scheduled, not
 *     yet due) is cancelled in the same transaction. Its sender would
 *     otherwise fail later on the missing conversation;
 *   - the stored media files the conversation's messages named are removed
 *     after the commit, unless the workspace still names them (one broadcast's
 *     file is the same stored file in every recipient's message). Same helper
 *     as a contact's erasure;
 *   - one audit row: who, how many messages. No message text and no customer
 *     detail in it.
 *
 * Rows in tables that keep a bare conversation id with no foreign key (runs,
 * approvals, bookings, usage and the like) are left as they are: they belong
 * to other domains and none of them blocks the delete.
 *
 * Only this conversation is touched. A website chat that was merged into this
 * thread is its own conversation and stays.
 */
import { prisma, withHistoricalRecords, writeAudit, AuditAction } from "@chatcenter/shared";
import { uploadNameOf, removeUnnamedUploads } from "./erase-uploads";

/** What a cancelled scheduled message says in its error column. */
export const CANCELLED_BY_DELETE = "Conversation deleted";

export type DeleteConversationResult =
  | { outcome: "not_found" }
  | { outcome: "must_close" }
  | {
      outcome: "deleted";
      conversationId: string;
      messages: number;
      scheduledCancelled: number;
      uploadsRemoved: number;
      uploadsKeptShared: number;
      uploadsLeftBehind: number;
    };

class Gone extends Error {}

export async function deleteConversation(args: {
  tenantId: string;
  conversationId: string;
  /** An open conversation is deleted only when the caller says so. */
  force: boolean;
  actorId: string | null;
}): Promise<DeleteConversationResult> {
  const { tenantId, conversationId, force, actorId } = args;

  // Live conversations only, as before: an imported-history conversation is
  // not in the inbox and is not deleted from it.
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, tenantId },
    select: { id: true, status: true, channel: true, customerAvatarUrl: true },
  });
  if (!conversation) return { outcome: "not_found" };
  if (conversation.status !== "CLOSED" && !force) return { outcome: "must_close" };

  // Every message of the conversation, whatever its origin: the cascade takes
  // them all, so the count and the file names must cover them all.
  const done = await withHistoricalRecords(async () => {
    const mediaRows = await prisma.message.findMany({
      where: { tenantId, conversationId, mediaUrl: { not: null } },
      select: { mediaUrl: true },
    });
    const fileNames = [
      ...mediaRows.map((m) => uploadNameOf(m.mediaUrl)),
      uploadNameOf(conversation.customerAvatarUrl),
    ].filter((n): n is string => !!n);

    try {
      const counts = await prisma.$transaction(async (tx) => {
        const scheduled = await tx.scheduledMessage.updateMany({
          where: { tenantId, conversationId, status: "PENDING" },
          data: { status: "CANCELLED", error: CANCELLED_BY_DELETE },
        });
        const messages = await tx.message.deleteMany({ where: { tenantId, conversationId } });
        const gone = await tx.conversation.deleteMany({ where: { id: conversationId, tenantId } });
        // Somebody else deleted it first: undo the rest and answer not found.
        if (gone.count !== 1) throw new Gone();
        return { messages: messages.count, scheduled: scheduled.count };
      });
      return { ...counts, fileNames };
    } catch (err) {
      if (err instanceof Gone) return null;
      throw err;
    }
  });
  if (!done) return { outcome: "not_found" };

  // After the commit: a file that could not be removed must not undo the delete.
  const files = await removeUnnamedUploads(tenantId, done.fileNames);

  await writeAudit({
    tenantId,
    actorType: "user",
    actorId,
    action: AuditAction.CONVERSATION_DELETED,
    targetType: "conversation",
    targetId: conversationId,
    metadata: {
      messageCount: done.messages,
      channel: conversation.channel,
      statusBefore: conversation.status,
      forced: conversation.status !== "CLOSED",
      scheduledCancelled: done.scheduled,
      uploadsRemoved: files.removed,
      uploadsKeptShared: files.kept.length,
      uploadsLeftBehind: files.left.length,
    },
  });

  return {
    outcome: "deleted",
    conversationId,
    messages: done.messages,
    scheduledCancelled: done.scheduled,
    uploadsRemoved: files.removed,
    uploadsKeptShared: files.kept.length,
    uploadsLeftBehind: files.left.length,
  };
}
