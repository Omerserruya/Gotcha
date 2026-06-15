/**
 * BullMQ worker that drains the `notifications` queue.
 *
 * Each job's data is a SystemEvent. The worker delegates to
 * `processEvent()` (see notification-engine.service.ts) which handles
 * preference matching, conditions, dedup, recipient resolution, and
 * downstream channel dispatch.
 *
 * Started from services/ai/src/index.ts when NOTIFICATIONS_ENABLED=true.
 */

import type { Job, Worker } from "bullmq";
import { createWorker } from "@chatcenter/shared";
import { NOTIFICATIONS_QUEUE_NAME } from "./queues";
import { processEvent } from "./notification-engine.service";
import type { SystemEvent } from "./event-emitter.service";

let _worker: Worker<SystemEvent> | null = null;

export function startNotificationsDispatcherWorker(): Worker<SystemEvent> {
  if (_worker) return _worker;
  _worker = createWorker<SystemEvent>(
    NOTIFICATIONS_QUEUE_NAME,
    async (job: Job<SystemEvent>) => {
      const event = job.data;
      if (!event || !event.tenantId || !event.type) {
        console.warn("[notifications.dispatcher] malformed job payload - skipped", job.id);
        return;
      }
      try {
        await processEvent(event);
      } catch (err: any) {
        // Re-throw so BullMQ records the failure and applies retry/backoff.
        console.error("[notifications.dispatcher] processEvent failed:", err?.message);
        throw err;
      }
    },
    { concurrency: 10 },
  );
  console.log("[notifications] dispatcher worker started (queue=notifications)");
  return _worker;
}

export async function stopNotificationsDispatcherWorker(): Promise<void> {
  if (!_worker) return;
  await _worker.close();
  _worker = null;
}
