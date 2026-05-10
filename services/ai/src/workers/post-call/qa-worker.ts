import { createWorker } from "@chatcenter/shared";
import type { Job, Worker } from "bullmq";
import {
  POST_CALL_QA_QUEUE_NAME,
  type PostCallQAJobData,
} from "../../services/intelligence/queues";
import { runQA } from "./qa-runner";

/**
 * BullMQ worker for the post-call QA queue.
 *
 * One job per conversation. The worker calls `runQA` which is idempotent
 * at the QAScore level — re-running on the same conversation produces a
 * new QAScore row with a fresh `scoredAt` (preserves audit history). Phase
 * 5 doesn't dedupe at the queue layer; if dedup is needed later, BullMQ's
 * `jobId` can be set to `qa:${conversationId}:${rubricVersion}`.
 *
 * Started from services/ai/src/index.ts when NOTIFICATIONS_ENABLED=true
 * (the same env-flag controls all background workers).
 */

let _worker: Worker<PostCallQAJobData> | null = null;

export function startPostCallQAWorker(): Worker<PostCallQAJobData> {
  if (_worker) return _worker;
  _worker = createWorker<PostCallQAJobData>(
    POST_CALL_QA_QUEUE_NAME,
    async (job: Job<PostCallQAJobData>) => {
      const data = job.data;
      if (!data || !data.conversationId || !data.tenantId) {
        console.warn(
          "[post-call.qa] malformed job payload — skipped",
          job.id,
        );
        return;
      }
      const result = await runQA(data);
      if (!result.ok) {
        // Non-actionable failures (mode mismatch, no frames) are logged but
        // not thrown — they're not retryable. Real errors throw and BullMQ
        // applies retry/backoff.
        console.info(
          "[post-call.qa] skipped",
          job.id,
          "reason:",
          result.reason,
        );
        return;
      }
    },
    { concurrency: 5 },
  );
  console.log(
    `[post-call] qa worker started (queue=${POST_CALL_QA_QUEUE_NAME})`,
  );
  return _worker;
}

export async function stopPostCallQAWorker(): Promise<void> {
  if (!_worker) return;
  await _worker.close();
  _worker = null;
}
