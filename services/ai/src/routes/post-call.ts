import { Router, type Request, type Response } from "express";
import { authenticate, resolveTenant, requireActiveTenant } from "@chatcenter/shared";
import { TranscriptUtteranceSchema } from "@chatcenter/shared";
import { z } from "zod";
import {
  getPostCallAnalyzeQueue,
  DEFAULT_POST_CALL_JOB_OPTS,
  type PostCallAnalyzeJobData,
} from "../services/intelligence/queues";

/**
 * Phase 6 HTTP entry point for Mode B (async post-call analysis).
 *
 * POST /api/post-call/analyze - accepts either pasted transcript utterances
 * or a recording URL, enqueues a BullMQ job, returns 202 with the job id.
 * The worker drives `runAsyncAnalysis`, persists CallAnalysis + QAScore,
 * emits `analysis.started` / `analysis.completed`. The caller (admin UI)
 * subscribes to the bus to render progress.
 *
 * Authorization: ADMIN-tenant scope. The route piggybacks on the existing
 * `authenticate + resolveTenant + requireActiveTenant` chain - same shape
 * as `/api/notification-preferences` etc.
 */

const router = Router();
router.use("/post-call", authenticate, resolveTenant, requireActiveTenant());

const UploadedSourceSchema = z.object({
  kind: z.literal("uploaded"),
  utterances: z.array(TranscriptUtteranceSchema).min(1),
});

const RecordingSourceSchema = z.object({
  kind: z.literal("recording"),
  recordingUrl: z.string().url(),
});

const AnalyzeRequestSchema = z.object({
  conversationId: z.string().min(1),
  source: z.discriminatedUnion("kind", [
    UploadedSourceSchema,
    RecordingSourceSchema,
  ]),
});

router.post("/post-call/analyze", async (req: Request, res: Response) => {
  const parse = AnalyzeRequestSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "invalid_request", issues: parse.error.issues });
    return;
  }
  const { conversationId, source } = parse.data;
  const tenantId = req.tenantId as string;

  const jobData: PostCallAnalyzeJobData = {
    conversationId,
    tenantId,
    source,
  };

  try {
    const job = await getPostCallAnalyzeQueue().add("analyze", jobData, {
      ...DEFAULT_POST_CALL_JOB_OPTS,
      // Per-conversation idempotency. A second submit re-runs only if the
      // first finished - operators wanting to force re-run can pass a unique
      // suffix in a future revision.
      jobId: `analyze-${conversationId}`,
    });
    res.status(202).json({ jobId: job.id, conversationId });
  } catch (err: any) {
    console.warn("[post-call.analyze.route] enqueue failed:", err?.message);
    res.status(500).json({ error: "enqueue_failed" });
  }
});

export default router;
