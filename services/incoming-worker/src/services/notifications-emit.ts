/**
 * The worker's producer onto the shared "notifications" BullMQ queue, consumed
 * by services/notifications (the same queue and event shape as
 * services/ai/src/services/notifications-emit.ts).
 *
 * Exists for one reason (2026-10-25): the worker's own handoffs (the AI failing,
 * AI units exhausted, the autonomy caps, an explicit request for a person) set
 * the conversation WAITING and told the customer a person would pick up, and
 * notified nobody. Only escalations decided inside an AI turn were announced.
 */
import { randomUUID } from "crypto";
import { Queue } from "bullmq";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

let q: Queue | null = null;

export function emitEscalated(input: {
  tenantId: string;
  conversationId: string;
  agentId?: string;
  reason: string;
  summary?: string;
}): void {
  setImmediate(() => {
    try {
      q ??= new Queue("notifications", { connection: { url: REDIS_URL } });
      const id = randomUUID();
      void q
        .add(
          "conversation.escalated",
          {
            id,
            type: "conversation.escalated",
            tenantId: input.tenantId,
            data: { reason: input.reason, summary: input.summary, source: "worker" },
            metadata: { conversationId: input.conversationId, agentId: input.agentId, timestamp: new Date().toISOString() },
          },
          { removeOnComplete: 1000, removeOnFail: 100, attempts: 5, backoff: { type: "exponential", delay: 2_000 }, jobId: `evt-${id}` },
        )
        .catch((err) => console.warn("[notifications.emit] failed:", err?.message));
    } catch (err: any) {
      console.warn("[notifications.emit] failed:", err?.message);
    }
  });
}

/**
 * The bot is driving this conversation: its reply is on the way, and a person
 * pinged for every message of a conversation they do not have to answer would
 * learn to ignore the pings that matter. Same values the worker routes to the
 * bot on (incoming.worker.ts, "Ongoing AI conversation").
 */
const BOT_HANDLED = new Set(["ai_agent", "awaiting_approval", "flow", "sandbox"]);

/** A media message with no words of its own: the channel stores "[Image]" and the like. */
const PLACEHOLDER = /^\[[^\]]{1,40}\]$/;
const PREVIEW_MAX = 100;

/** The preview a push shows: the first ~100 chars, or the media kind for the template to name. */
export function inboundPreview(body: string | null | undefined, messageType: string | null | undefined): { preview: string; previewKind: "text" | "media" } {
  const text = (body ?? "").replace(/\s+/g, " ").trim();
  const isMedia = !!messageType && messageType !== "text";
  if (isMedia && (!text || PLACEHOLDER.test(text))) return { preview: text || `[${messageType}]`, previewKind: "media" };
  const cut = text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX - 1).trimEnd()}\u2026` : text;
  return { preview: cut, previewKind: "text" };
}

/** Whether this inbound message is announced to the assignee's phone. */
export function shouldEmitInbound(conversation: { assignedAgentId?: string | null; handledBy?: string | null }): boolean {
  if (!conversation.assignedAgentId) return false;
  return !BOT_HANDLED.has(String(conversation.handledBy ?? ""));
}

/**
 * "message.inbound" (mobile app, 2026-11-03): every inbound customer message
 * in a conversation a PERSON is assigned to goes to that person's phone. The
 * notifications service sends it as push only, to the assignee only. Returns
 * whether it was queued, for the caller's tests; never throws.
 */
export function emitInboundMessage(input: {
  tenantId: string;
  conversation: { id: string; assignedAgentId?: string | null; handledBy?: string | null; customerName?: string | null; departmentId?: string | null };
  messageId: string;
  body: string | null | undefined;
  messageType: string | null | undefined;
  channel: string;
  customerName?: string | null;
}): boolean {
  if (!shouldEmitInbound(input.conversation)) return false;
  const assignedAgentId = input.conversation.assignedAgentId!;
  setImmediate(() => {
    try {
      q ??= new Queue("notifications", { connection: { url: REDIS_URL } });
      const id = randomUUID();
      void q
        .add(
          "message.inbound",
          {
            id,
            type: "message.inbound",
            tenantId: input.tenantId,
            departmentId: input.conversation.departmentId ?? undefined,
            data: {
              conversationId: input.conversation.id,
              assignedAgentId,
              // The engine dedups on the payload for five minutes: without the
              // message id, a second "ok" from the same customer would be
              // swallowed as a repeat of the first.
              messageId: input.messageId,
              ...inboundPreview(input.body, input.messageType),
              messageType: input.messageType ?? "text",
              channel: input.channel,
              customerName: input.customerName ?? input.conversation.customerName ?? null,
            },
            metadata: { conversationId: input.conversation.id, userId: assignedAgentId, timestamp: new Date().toISOString() },
          },
          { removeOnComplete: 1000, removeOnFail: 100, attempts: 5, backoff: { type: "exponential", delay: 2_000 }, jobId: `evt-${id}` },
        )
        .catch((err) => console.warn("[notifications.emit] failed:", err?.message));
    } catch (err: any) {
      console.warn("[notifications.emit] failed:", err?.message);
    }
  });
  return true;
}
