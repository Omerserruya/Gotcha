import { Queue, type JobsOptions } from "bullmq";

/**
 * BullMQ queue for the Live Call CoPilot post-call pipeline (Phase 1).
 *
 * One job per VoiceCallSession. Jobs are enqueued by the subscriber when a
 * call ends and re-enqueued by the worker on transient stage failures with
 * exponential backoff. The worker drives the row's `stage` forward through
 * the canonical PostCallStage enum.
 *
 * Mirrors the connection pattern from `intelligence/queues/post-call-queues.ts`
 * (URL-based BullMQ connection so it works in any environment with REDIS_URL).
 */

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

export const VOICE_POSTCALL_QUEUE_NAME = "voice-postcall";
export const VOICE_POSTCALL_JOB_NAME = "advance";

let _queue: Queue | null = null;

export function getVoicePostCallQueue(): Queue {
  if (!_queue) {
    _queue = new Queue(VOICE_POSTCALL_QUEUE_NAME, {
      connection: { url: REDIS_URL },
    });
  }
  return _queue;
}

export const DEFAULT_VOICE_POSTCALL_JOB_OPTS: JobsOptions = {
  removeOnComplete: 500,
  removeOnFail: 1000,
};

export interface VoicePostCallJobData {
  sessionId: string;
}

/** Test seam — replace the lazily-instantiated queue with a stub. */
export function __setVoicePostCallQueueForTests(q: Queue | null): void {
  _queue = q;
}
