import { Queue, type JobsOptions } from "bullmq";
import type { TranscriptUtterance } from "@chatcenter/shared";

/**
 * BullMQ queues for the Post-Call Pilot.
 *
 * Phase 5 ships ONE queue: `post-call-qa` (Mode A QA validator).
 * Phase 6 will add `post-call-transcribe` and `post-call-analyze` (Mode B).
 *
 * Queue names use `-` (not `:`) per BullMQ v5's prohibition on colons.
 * The `notifications-email` queue rename in Phase 5's notifications work
 * established the convention; we follow it here.
 */

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

export const POST_CALL_QA_QUEUE_NAME = "post-call-qa";
export const POST_CALL_ANALYZE_QUEUE_NAME = "post-call-analyze";

let _qaQueue: Queue | null = null;
let _analyzeQueue: Queue | null = null;

export function getPostCallQAQueue(): Queue {
  if (!_qaQueue) {
    _qaQueue = new Queue(POST_CALL_QA_QUEUE_NAME, {
      connection: { url: REDIS_URL },
    });
  }
  return _qaQueue;
}

export function getPostCallAnalyzeQueue(): Queue {
  if (!_analyzeQueue) {
    _analyzeQueue = new Queue(POST_CALL_ANALYZE_QUEUE_NAME, {
      connection: { url: REDIS_URL },
    });
  }
  return _analyzeQueue;
}

/**
 * Defaults — exponential backoff for transient Redis/DB hiccups; 100 most
 * recent failures retained for on-call inspection. Same shape as the
 * notifications dispatcher's `DEFAULT_NOTIF_JOB_OPTS`.
 */
export const DEFAULT_POST_CALL_JOB_OPTS: JobsOptions = {
  removeOnComplete: 1000,
  removeOnFail: 100,
  attempts: 3,
  backoff: { type: "exponential", delay: 5_000 },
};

/** Test seam — replace the lazily-instantiated queue with a stub. */
export function __setQAQueueForTests(q: Queue | null): void {
  _qaQueue = q;
}

export function __setAnalyzeQueueForTests(q: Queue | null): void {
  _analyzeQueue = q;
}

export interface PostCallQAJobData {
  conversationId: string;
  tenantId: string;
  /** Optional — present iff the trigger originated from a voice call. */
  callSid?: string;
  /** Tenant-pinnable rubric version. Phase 5 V1 uses a single version. */
  rubricVersion?: string;
}

/**
 * Phase 6 — Mode B (async post-call) job.
 *
 * Two source kinds: pasted utterances or a recording URL. The worker
 * constructs the appropriate TranscriptSource and drives runAsyncAnalysis.
 * Type kept in this file (not in the runner) so the queue's TypeScript
 * surface is stable across worker / route consumers.
 */
export type PostCallAnalyzeJobSource =
  | { kind: "uploaded"; utterances: TranscriptUtterance[] }
  | { kind: "recording"; recordingUrl: string };

export interface PostCallAnalyzeJobData {
  conversationId: string;
  tenantId: string;
  source: PostCallAnalyzeJobSource;
}
