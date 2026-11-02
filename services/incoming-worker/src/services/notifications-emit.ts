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
