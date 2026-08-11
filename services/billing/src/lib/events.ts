/**
 * Billing event emitter - fire-and-forget, enqueues a SystemEvent onto the
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
  // Distinct from past_due on purpose: past_due means the customer definitely
  // was not charged and dunning may retry. This one means we do not know, and
  // nothing automated may act on it.
  | "subscription.renewal_unknown"
  | "payment.reconciliation_required"
  // The money moved and the tax document did not issue. NOT a payment failure -
  // nothing may retry the charge on the strength of it. It is a document to
  // chase, with the charge reference already in hand.
  | "payment.document_failed"
  | "invoice.issued"
  | "invoice.paid"
  | "payment.failed"
  | "payment_method.expiring"
  | "credit.threshold"
  | "credit.exhausted"
  | "credit.auto_purchase_succeeded"
  | "credit.auto_purchase_failed"
  | "credit.auto_purchase_ceiling_reached"
  // Pay-as-you-go hit its cap. Distinct from the auto-purchase ceiling: that one
  // means "we stopped buying", this one means "we stopped serving", and the
  // customer needs to be told a different thing in each case.
  | "credit.payg_ceiling_reached";

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

/**
 * How long a money operation will wait on the notification queue.
 *
 * Bounded on purpose. BullMQ retries a connection indefinitely rather than
 * throwing, so an `await` on a queue that cannot be reached simply never
 * returns - and this is called from inside charge handling. A notification
 * outage must not hold a charge open or, worse, leave its outcome unrecorded.
 * Losing the notification is bad; losing the money record is worse.
 */
const EMIT_TIMEOUT_MS = 2_000;

export async function emitBillingEvent(input: EmitBillingEventInput): Promise<void> {
  try {
    const event = {
      id: randomUUID(),
      type: input.type,
      tenantId: input.tenantId,
      data: input.data,
      metadata: { userId: input.userId, timestamp: new Date().toISOString() },
    };
    const enqueued = queue().add("system-event", event, {
      removeOnComplete: 1000,
      removeOnFail: 100,
      attempts: 5,
      backoff: { type: "exponential", delay: 2_000 },
    });
    await Promise.race([
      enqueued,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("notification queue did not accept in time")), EMIT_TIMEOUT_MS),
      ),
    ]);
    // The enqueue may still land after the race; swallow its rejection so an
    // unreachable queue cannot surface as an unhandled rejection later.
    enqueued.catch(() => {});
  } catch (err: any) {
    console.warn("[billing/events] emit failed:", err?.message ?? err);
  }
}
