/**
 * AI Bot routes - autonomous mode reply generation.
 *
 * Internal-only: protected by the same `X-Internal-Key` shared secret as
 * /api/ai-assist/intent. Called by the incoming-worker which holds all
 * channel-side effects (sending the reply, persisting messages, escalating
 * the conversation). This service never sends WhatsApp / Instagram
 * messages on its own - it just computes the next AI move.
 */

import { Router, Request, Response } from "express";
import { requireInternalKey } from "@chatcenter/shared";
import { generateAIBotReply, generateAIBotOneshot, generateExecutionMessage } from "../services/ai-bot.service";

const router = Router();

// Hardened internal gate: constant-time, fail-closed, no committed default.
router.use(requireInternalKey);

// POST /api/ai-bot/reply
//   body: { tenantId, conversationId, aiAgentId, incomingMessage, closedHours? }
//   `closedHours` (worker-computed from the tenant's persisted business hours)
//   marks the business as currently CLOSED with the "active" outside-hours
//   policy - the reply must not imply immediate human availability.
//   returns: AIBotReplyResult
router.post("/reply", async (req: Request, res: Response) => {
  try {
    const { tenantId, conversationId, aiAgentId, incomingMessage, closedHours } = req.body || {};
    if (!tenantId || !conversationId || !aiAgentId || typeof incomingMessage !== "string") {
      res.status(400).json({ error: "tenantId, conversationId, aiAgentId, and incomingMessage are required" });
      return;
    }
    const result = await generateAIBotReply({ tenantId, conversationId, aiAgentId, incomingMessage, closedHours });
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
// POST /api/ai-bot/execution-message
//   The ONE generator for post-execution customer messages (approval
//   continuations, proactive completion updates). Same humanizer/style layer
//   as live replies + deterministic grounding validation with a safe
//   template fallback - callers always get a sendable, fact-true message.
//   body: { tenantId, aiAgentId, facts, inboundSample?, customerName? }
router.post("/execution-message", async (req: Request, res: Response) => {
  try {
    const { tenantId, aiAgentId, facts, inboundSample, customerName } = req.body || {};
    if (!tenantId || !aiAgentId || !facts || typeof facts.tool !== "string" || !facts.outcome) {
      res.status(400).json({ error: "tenantId, aiAgentId and facts{tool,outcome} are required" });
      return;
    }
    const result = await generateExecutionMessage({
      tenantId,
      aiAgentId,
      facts,
      inboundSample: typeof inboundSample === "string" ? inboundSample : "",
      customerName: typeof customerName === "string" ? customerName : undefined,
    });
    res.json(result);
  } catch (err: any) {
    console.error("[ai-bot/execution-message] error:", err?.message);
    res.status(err?.status || 500).json({ error: err?.message || "Failed to generate execution message" });
  }
});

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
