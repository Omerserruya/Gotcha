/**
 * POST /api/internal/voice-learn - learn the voice from live conversations.
 *
 * INTERNAL ONLY, and a sibling of `/api/internal/voice-sample` for the same
 * reason: the customer-facing endpoint is POST /api/workspace/voice/learn in
 * services/auth, which owns the workspace screen, and it delegates here
 * because a NEW model call belongs only in this service.
 *
 * Returns 200 with a status for every outcome that is not a fault, including
 * the refusals. "There is not enough of your own writing yet" and "your edit
 * is being kept" are both answers the screen has to render as sentences with
 * numbers in them, not as errors - an error code would leave the screen
 * guessing at what to say.
 */
import { Router, type Request, type Response } from "express";
import { requireInternalKey } from "@chatcenter/shared";
import { learnVoiceFromLiveWriting } from "../services/live-voice.service";

const router = Router();

router.post("/internal/voice-learn", requireInternalKey, async (req: Request, res: Response) => {
  const { tenantId } = (req.body ?? {}) as { tenantId?: string };
  if (!tenantId) {
    res.status(400).json({ error: "tenantId is required" });
    return;
  }

  try {
    res.json(await learnVoiceFromLiveWriting(tenantId));
  } catch (err) {
    console.error("[voice-learn] failed:", (err as Error).message);
    res.status(503).json({ error: "learn_unavailable" });
  }
});

export default router;
