/**
 * AI Bot routes — autonomous mode reply generation.
 *
 * Internal-only: protected by the same `X-Internal-Key` shared secret as
 * /api/ai-assist/intent. Called by the incoming-worker which holds all
 * channel-side effects (sending the reply, persisting messages, escalating
 * the conversation). This service never sends WhatsApp / Instagram
 * messages on its own — it just computes the next AI move.
 */

import { Router, Request, Response, NextFunction } from "express";
import { generateAIBotReply, generateAIBotOneshot } from "../services/ai-bot.service";

const router = Router();

router.use((req: Request, res: Response, next: NextFunction) => {
  const key = req.headers["x-internal-key"];
  if (!key || key !== (process.env.INTERNAL_SERVICE_KEY || "chatcenter-internal-2026")) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  next();
});

// POST /api/ai-bot/reply
//   body: { tenantId, conversationId, aiAgentId, incomingMessage }
//   returns: AIBotReplyResult
router.post("/reply", async (req: Request, res: Response) => {
  try {
    const { tenantId, conversationId, aiAgentId, incomingMessage } = req.body || {};
    if (!tenantId || !conversationId || !aiAgentId || typeof incomingMessage !== "string") {
      res.status(400).json({ error: "tenantId, conversationId, aiAgentId, and incomingMessage are required" });
      return;
    }
    const result = await generateAIBotReply({ tenantId, conversationId, aiAgentId, incomingMessage });
    res.json(result);
  } catch (err: any) {
    const status = err?.status || 500;
    // 499 = client-side cancel. The newer inbound for this conversation
    // aborted the LLM call mid-flight; the worker treats this as a silent
    // no-op (no escalation, no error log). Keep the log line at debug
    // volume so it's grep-able when explaining "why no reply was sent".
    if (err?.aborted || status === 499) {
      console.log(
        `[ai-bot/reply] aborted conv=${req.body?.conversationId} (newer turn took over)`,
      );
      res.status(499).json({ aborted: true, error: "aborted-by-newer-turn" });
      return;
    }
    console.error("[ai-bot/reply] error:", err.message);
    res.status(status).json({ error: err.message || "Failed to generate reply" });
  }
});

// POST /api/ai-bot/oneshot
//   body: { tenantId, aiAgentId, userInput, maxTokens?, feature? }
//   returns: { reply, modelUsed, totalTokens }
router.post("/oneshot", async (req: Request, res: Response) => {
  try {
    const { tenantId, aiAgentId, userInput, maxTokens, feature } = req.body || {};
    if (!tenantId || !aiAgentId || typeof userInput !== "string") {
      res.status(400).json({ error: "tenantId, aiAgentId, and userInput are required" });
      return;
    }
    const result = await generateAIBotOneshot({ tenantId, aiAgentId, userInput, maxTokens, feature });
    res.json(result);
  } catch (err: any) {
    const status = err?.status || 500;
    console.error("[ai-bot/oneshot] error:", err.message);
    res.status(status).json({ error: err.message || "Failed to generate one-shot reply" });
  }
});

export default router;
