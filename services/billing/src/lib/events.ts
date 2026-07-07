/**
 * Billing event emitter — fire-and-forget, enqueues a SystemEvent onto the
 * shared "notifications" BullMQ queue (same shape the notifications service's
 * dispatcher consumes). Never throws; instrumentation must not break billing.
 *
 * The notifications service owns the SystemEventType union + NotificationPreference
 * rows for these types (extended in Phase 4). Producing compatible jobs here
 * keeps billing decoupled from the notifications service at runtime.
 */
import { Queue } from "bullmq";
import { randomUUID } from "crypto";

export type BillingEventType =
  | "subscription.trial_started"
  | "subscription.trial_ending"
  | "subscription.activated"
  | "subscription.plan_changed"
  | "subscription.canceled"
  | "subscription.resumed"
  | "subscription.suspended"
  | "subscription.past_due"
  | "invoice.issued"
  | "invoice.paid"
  | "payment.failed"
  | "payment_method.expiring"
  | "credit.threshold"
  | "credit.exhausted"
  | "credit.auto_purchase_succeeded"
  | "credit.auto_purchase_failed"
  | "credit.auto_purchase_ceiling_reached";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
let _queue: Queue | null = null;
function queue(): Queue {
  if (!_queue) _queue = new Queue("notifications", { connection: { url: REDIS_URL } });
  return _queue;
}

export interface EmitBillingEventInput {
  type: BillingEventType;
  tenantId: string;
  data: Record<string, unknown>;
  userId?: string;
}

export async function emitBillingEvent(input: EmitBillingEventInput): Promise<void> {
  try {
    const event = {
      id: randomUUID(),
      type: input.type,
      tenantId: input.tenantId,
      data: input.data,
      metadata: { userId: input.userId, timestamp: new Date().toISOString() },
    };
    await queue().add("system-event", event, {
      removeOnComplete: 1000,
      removeOnFail: 100,
      attempts: 5,
      backoff: { type: "exponential", delay: 2_000 },
    });
  } catch (err: any) {
    console.warn("[billing/events] emit failed:", err?.message ?? err);
  }
}
