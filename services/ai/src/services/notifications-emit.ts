/**
 * Cross-service shim: enqueues a SystemEvent onto the shared Redis-backed
 * BullMQ "notifications" queue, which is consumed by services/notifications.
 *
 * Same public API (`tryEmit`, `emitEvent`, `SystemEventType`, `EmitEventInput`)
 * that AI hot paths used to import from `./notifications/event-emitter.service`
 * — so callers (ai-bot.service.ts) only need a path swap.
 *
 * The queue name and Redis URL must match services/notifications/src/services/queues.ts.
 * BullMQ queues are just Redis keys — multiple producers across services are fine.
 */
import { randomUUID } from "crypto";
import { Queue, type JobsOptions } from "bullmq";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const NOTIFICATIONS_QUEUE_NAME = "notifications";

const DEFAULT_OPTS: JobsOptions = {
  removeOnComplete: 1000,
  removeOnFail: 100,
  attempts: 5,
  backoff: { type: "exponential", delay: 2_000 },
};

let _q: Queue | null = null;
function getQ(): Queue {
  if (!_q) {
    _q = new Queue(NOTIFICATIONS_QUEUE_NAME, { connection: { url: REDIS_URL } });
  }
  return _q;
}

export type SystemEventType =
  | "tool.approval_required"
  | "lead.created"
  | "meeting.scheduled"
  | "discount.applied"
  | "refund.issued"
  | "conversation.escalated"
  | "high_value_lead.detected"
  | "payment.failed"
  | "system.error.critical";

export interface SystemEventMetadata {
  conversationId?: string;
  agentId?: string;
  userId?: string;
  timestamp: string;
}

export interface SystemEvent {
  id: string;
  type: SystemEventType;
  tenantId: string;
  departmentId?: string;
  data: Record<string, unknown>;
  metadata: SystemEventMetadata;
}

export interface EmitEventInput {
  type: SystemEventType;
  tenantId: string;
  departmentId?: string;
  data: Record<string, unknown>;
  metadata?: Partial<SystemEventMetadata>;
}

export async function emitEvent(input: EmitEventInput): Promise<void> {
  try {
    const event: SystemEvent = {
      id: randomUUID(),
      type: input.type,
      tenantId: input.tenantId,
      departmentId: input.departmentId,
      data: input.data ?? {},
      metadata: {
        timestamp: input.metadata?.timestamp ?? new Date().toISOString(),
        conversationId: input.metadata?.conversationId,
        agentId: input.metadata?.agentId,
        userId: input.metadata?.userId,
      },
    };
    await getQ().add(input.type, event, { ...DEFAULT_OPTS, jobId: `evt:${event.id}` });
  } catch (err: any) {
    console.warn("[notifications.emit] failed:", err?.message);
  }
}

export function tryEmit(input: EmitEventInput): void {
  setImmediate(() => {
    emitEvent(input).catch((err) => {
      console.warn("[notifications.tryEmit] swallowed:", err?.message);
    });
  });
}
