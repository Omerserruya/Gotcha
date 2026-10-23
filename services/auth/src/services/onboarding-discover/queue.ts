/**
 * The onboarding-discover queue: POST /discover/job only enqueues, the worker
 * runs the scan, so a browser timeout or a reload never strands the user.
 *
 * The BullMQ job id is the scan's jobId, so enqueueing the same scan twice is
 * one run. A worker that dies mid-run is picked up by BullMQ's stalled-job
 * check and the run starts over under the same jobId.
 */
import { Queue } from "bullmq";
import { createWorker } from "@chatcenter/shared";
import { runDiscoverJob, type PipelineDeps } from "./pipeline";

export const ONBOARDING_DISCOVER_QUEUE = "onboarding-discover";
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

let _queue: Queue | null = null;
function queue(): Queue {
  if (!_queue) _queue = new Queue(ONBOARDING_DISCOVER_QUEUE, { connection: { url: REDIS_URL } });
  return _queue;
}

export interface DiscoverJobData { tenantId: string; jobId: string }

/**
 * `attempt` makes a retry a new BullMQ job: BullMQ ignores an add whose id it
 * still holds (completed and failed jobs are kept), which would swallow it.
 */
export async function enqueueDiscover(tenantId: string, jobId: string, attempt = 0): Promise<void> {
  await queue().add("discover", { tenantId, jobId } satisfies DiscoverJobData, {
    // BullMQ refuses ":" in a custom id.
    jobId: `${tenantId}-${jobId}-${attempt}`,
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 50 },
  });
}

/** Started once at auth boot, next to the nudge worker. */
export function startOnboardingDiscoverWorker(deps: () => PipelineDeps = () => ({})): void {
  try {
    createWorker<DiscoverJobData>(
      ONBOARDING_DISCOVER_QUEUE,
      async (job) => { await runDiscoverJob(job.data.tenantId, job.data.jobId, deps()); },
      2,
    );
    console.log("[onboarding-discover] worker started");
  } catch (err: any) {
    console.error("[onboarding-discover] failed to start worker:", err?.message);
  }
}
