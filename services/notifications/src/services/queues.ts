/**
 * BullMQ queues for the event-driven notification engine.
 *
 * Two queues:
 *   - `notifications`        → engine processor; turns a SystemEvent into per-recipient × per-channel jobs.
 *   - `notifications-email`  → email worker; one job per recipient × email channel.
 *
 * Mirrors the patterns used in @chatcenter/shared/lib/queue.ts (single
 * IORedis URL, BullMQ Queue/Worker, removeOnComplete, exponential backoff)
 * so ops/dashboards don't need a second Redis or queue conventions.
 *
 * Test environments mock these queues (see __tests__/notifications.test.ts).
 * The runtime always lazily instantiates so import order doesn't matter.
 */

import { Queue, type JobsOptions } from "bullmq";
import { NOTIFICATIONS_EMAIL_QUEUE_NAME as EMAIL_QUEUE } from "@chatcenter/shared";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

let _notificationsQueue: Queue | null = null;
let _notificationsEmailQueue: Queue | null = null;

export function getNotificationsQueue(): Queue {
  if (!_notificationsQueue) {
    _notificationsQueue = new Queue("notifications", { connection: { url: REDIS_URL } });
  }
  return _notificationsQueue;
}

export function getNotificationsEmailQueue(): Queue {
  if (!_notificationsEmailQueue) {
    _notificationsEmailQueue = new Queue(EMAIL_QUEUE, { connection: { url: REDIS_URL } });
  }
  return _notificationsEmailQueue;
}

// Defaults - exponential backoff so transient SMTP/Redis hiccups don't
// poison the queue. removeOnComplete bounds Redis memory; failures stay
// for 100 jobs so on-call can inspect a recent batch.
export const DEFAULT_NOTIF_JOB_OPTS: JobsOptions = {
  removeOnComplete: 1000,
  removeOnFail: 100,
  attempts: 5,
  backoff: { type: "exponential", delay: 2_000 },
};

// Allow tests to inject mock queues without monkey-patching modules.
export function __setQueuesForTests(opts: { dispatcher?: Queue | null; email?: Queue | null }) {
  if (opts.dispatcher !== undefined) _notificationsQueue = opts.dispatcher;
  if (opts.email !== undefined) _notificationsEmailQueue = opts.email;
}

export const NOTIFICATIONS_QUEUE_NAME = "notifications";
// Re-exported, not redeclared: billing fills this queue and needs the same name
// from a place it is allowed to import. Two copies of a queue name is a silent
// misroute waiting for someone to edit one of them.
export { NOTIFICATIONS_EMAIL_QUEUE_NAME } from "@chatcenter/shared";
