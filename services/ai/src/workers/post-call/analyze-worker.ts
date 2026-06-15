import { createWorker } from "@chatcenter/shared";
import type { Job, Worker } from "bullmq";
import {
  POST_CALL_ANALYZE_QUEUE_NAME,
  type PostCallAnalyzeJobData,
} from "../../services/intelligence/queues";
import { runAsyncAnalysis } from "./async-runner";

/**
 * Phase 6 BullMQ worker for the post-call-analyze queue (Mode B).
 *
 * Same shape as the Mode A QA worker - concurrency 5, structured failure
 * handling. Non-actionable failures (Whisper unconfigured, malformed
 * payload) log but don't throw; transient failures bubble for BullMQ to
 * retry.
 */

let _worker: Worker<PostCallAnalyzeJobData> | null = null;

export function startPostCallAnalyzeWorker(): Worker<PostCallAnalyzeJobData> {
  if (_worker) return _worker;
  _worker = createWorker<PostCallAnalyzeJobData>(
    POST_CALL_ANALYZE_QUEUE_NAME,
    async (job: Job<PostCallAnalyzeJobData>) => {
      const data = job.data;
      if (!data || !data.conversationId || !data.tenantId || !data.source) {
        console.warn(
          "[post-call.analyze] malformed job payload - skipped",
          job.id,
        );
        return;
      }
      const result = await runAsyncAnalysis({
        conversationId: data.conversationId,
        tenantId: data.tenantId,
        source: data.source,
      });
      if (!result.ok) {
        // Same policy as Mode A QA worker: known non-retryable reasons log,
        // unknown errors throw to engage backoff.
        console.info(
          "[post-call.analyze] skipped",
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
    `[post-call] analyze worker started (queue=${POST_CALL_ANALYZE_QUEUE_NAME})`,
  );
  return _worker;
}

export async function stopPostCallAnalyzeWorker(): Promise<void> {
  if (!_worker) return;
  await _worker.close();
  _worker = null;
}
