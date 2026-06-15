/**
 * Existing action items loader - fetches tasks + scheduled follow-ups that
 * already exist for a contact/conversation BEFORE the post-conversation
 * summarizer runs.
 *
 * Why: the bot can call `create_task` / `schedule_followup` mid-conversation
 * via its tool surface. If the summarizer doesn't see those, it will happily
 * propose the same work again, and the post-chat / voice-postcall pipelines
 * will materialize duplicates in the CRM and queue duplicate outbound
 * messages.
 *
 * The summarizer consumes this snapshot as prompt context and dedups by
 * INTENT (not literal subject match), so two surface-different but
 * semantically identical items collapse into one.
 *
 * Best-effort: any DB failure returns the empty shape so the pipeline still
 * runs - the summarizer just won't have dedup context that turn.
 */

import { prisma } from "@chatcenter/shared";

export interface ExistingTaskItem {
  /** What the task is about - already-sanitized string for prompt context. */
  subject: string;
  /** Optional body / details. */
  body?: string;
  /** ISO timestamp the task was created at. */
  createdAt: string;
}

export interface ExistingFollowupItem {
  /** Ready-to-send body of the scheduled message. */
  body: string;
  /** ISO timestamp it's scheduled to fire at. */
  scheduledAt: string;
}

export interface ExistingActionItems {
  tasks: ExistingTaskItem[];
  pendingFollowups: ExistingFollowupItem[];
}

const EMPTY: ExistingActionItems = { tasks: [], pendingFollowups: [] };

/**
 * Loads:
 *   - tasks: every `action.create_task` AuditLog row for the conversation's
 *     contact, recorded since the conversation started. We use the audit log
 *     (not the vendor CRM) because it's the deterministic source of truth
 *     for what the bot/agent actually did mid-conversation, vendor-agnostic.
 *   - pendingFollowups: PENDING ScheduledMessage rows targeting the same
 *     recipient on the same channel - these are real outbound messages
 *     queued for the scheduled-messages worker to send.
 */
export async function loadExistingActionItems(args: {
  tenantId: string;
  conversationId: string;
}): Promise<ExistingActionItems> {
  try {
    const conv = await prisma.conversation.findUnique({
      where: { id: args.conversationId },
      select: {
        createdAt: true,
        channel: true,
        customerExternalId: true,
      },
    });
    if (!conv) return EMPTY;

    // Resolve the local Contact row so we can query AuditLog by targetId.
    const contact = await prisma.contact.findFirst({
      where: {
        tenantId: args.tenantId,
        channel: conv.channel as any,
        externalId: conv.customerExternalId,
      },
      select: { id: true },
    });

    const [taskRows, followupRows] = await Promise.all([
      contact?.id
        ? prisma.auditLog.findMany({
            where: {
              tenantId: args.tenantId,
              action: "action.create_task",
              targetId: contact.id,
              createdAt: { gte: conv.createdAt },
            },
            select: { metadata: true, createdAt: true },
            orderBy: { createdAt: "asc" },
            take: 20,
          })
        : Promise.resolve([]),
      prisma.scheduledMessage.findMany({
        where: {
          tenantId: args.tenantId,
          status: "PENDING" as any,
          channel: conv.channel as any,
          recipientExternalId: conv.customerExternalId,
        },
        select: { body: true, scheduledAt: true },
        orderBy: { scheduledAt: "asc" },
        take: 20,
      }),
    ]);

    const tasks: ExistingTaskItem[] = [];
    for (const r of taskRows) {
      const params = (r.metadata as any)?.params;
      const subject = typeof params?.subject === "string" ? params.subject.trim() : "";
      if (!subject) continue;
      const body = typeof params?.body === "string" ? params.body.trim() : undefined;
      tasks.push({
        subject,
        body: body || undefined,
        createdAt: r.createdAt.toISOString(),
      });
    }

    const pendingFollowups: ExistingFollowupItem[] = followupRows.map((r) => ({
      body: r.body,
      scheduledAt: r.scheduledAt.toISOString(),
    }));

    return { tasks, pendingFollowups };
  } catch {
    return EMPTY;
  }
}
