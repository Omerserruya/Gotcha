/**
 * Event emitter for the notification system.
 *
 * The single entry point used by every "hot path" in the AI service to
 * publish a domain event without blocking. Emit is fire-and-forget:
 *   - the caller awaits at most a queue.add() (or setImmediate), never the
 *     fan-out / dispatch / send.
 *   - failures are caught and logged; they NEVER bubble into the AI
 *     reply path or break a chat turn.
 *
 * Downstream:
 *   1. Job lands in the `notifications` queue with the SystemEvent payload.
 *   2. The dispatcher worker (notifications-dispatcher.worker.ts) loads it,
 *      resolves NotificationPreference rows, applies conditions + dedup,
 *      and enqueues per-recipient × per-channel dispatch jobs.
 */

import { randomUUID } from "crypto";
import type { JobsOptions } from "bullmq";
import { getNotificationsQueue, DEFAULT_NOTIF_JOB_OPTS } from "./queues";

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
  /** ISO 8601 UTC timestamp. Stamped automatically when omitted. */
  timestamp: string;
}

export interface SystemEvent {
  /** Server-generated id (cuid-ish). */
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

/**
 * Enqueue a SystemEvent for downstream notification fan-out.
 *
 * Never throws - wraps every step in try/catch and logs at warn level.
 * Returns void so callers don't accidentally await side-effects.
 */
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
    const opts: JobsOptions = {
      ...DEFAULT_NOTIF_JOB_OPTS,
      // BullMQ rejects ':' in custom job IDs (it's the namespace separator on the
      // underlying Redis keys). Use a hyphen so the prefix still aids debugging.
      jobId: `evt-${event.id}`,
    };
    await getNotificationsQueue().add(input.type, event, opts);
  } catch (err: any) {
    console.warn("[notifications.emit] failed:", err?.message);
  }
}

/**
 * Convenience helper for AI hot-paths. Schedules emit on the next tick so
 * the calling code returns to the LLM/turn loop immediately. Wraps emit in
 * its own try/catch so a notification path issue can never propagate.
 *
 * Use this from ai-bot.service.ts, behavior-engine consumers, action
 * contracts, etc. - anywhere a sync hot path can't await even a queue.add().
 */
export function tryEmit(input: EmitEventInput): void {
  setImmediate(() => {
    emitEvent(input).catch((err) => {
      console.warn("[notifications.tryEmit] swallowed:", err?.message);
    });
  });
}
