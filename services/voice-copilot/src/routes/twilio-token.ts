/**
 * POST /api/voice-copilot/token
 *
 * Mints a short-lived voice access token (Voice grant) for a logged-in
 * agent. The browser uses this token to register the provider's client
 * SDK (Twilio Device today) and place outbound calls.
 *
 * The provider is resolved per-request from the agent's tenant via the
 * `VoiceProviderResolver`. Tenants without an ACTIVE voice channel get
 * 503; tenants whose channel lacks the API Key/TwiML App credentials
 * needed to mint a token also get 503.
 */
import { Router, Request, Response } from "express";
import { verifyToken } from "@chatcenter/shared";
import type { Logger } from "../lib/logger";
import type { VoiceProvider, VoiceProviderResolver } from "../providers/voice-provider";
import { NoActiveVoiceChannelError } from "../providers/resolve-provider";

export function createTwilioTokenRouter(opts: { resolveProvider: VoiceProviderResolver; logger: Logger }): Router {
  const router = Router();
  const { resolveProvider, logger } = opts;

  router.post("/", async (req: Request, res: Response) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      res.status(401).json({ error: "missing_authorization" });
      return;
    }

    let payload;
    try {
      payload = verifyToken(header.slice(7));
    } catch {
      res.status(401).json({ error: "invalid_token" });
      return;
    }

    let provider: VoiceProvider;
    try {
      provider = await resolveProvider(payload.tenantId);
    } catch (err) {
      if (err instanceof NoActiveVoiceChannelError) {
        logger.warn({ userId: payload.userId, tenantId: payload.tenantId }, "voice-copilot token: no active voice channel");
        res.status(503).json({ error: "no_active_voice_channel" });
        return;
      }
      logger.error({ err, userId: payload.userId, tenantId: payload.tenantId }, "voice-copilot token: provider resolve failed");
      res.status(500).json({ error: "provider_resolve_failed" });
      return;
    }

    if (!provider.isClientConfigured) {
      logger.warn({ userId: payload.userId, tenantId: payload.tenantId }, "voice-copilot token requested but Twilio API key not configured");
      res.status(503).json({ error: "twilio_not_configured" });
      return;
    }

    const identity = `agent_${payload.userId}`;
    try {
      const { token, expiresIn } = provider.mintClientAccessToken({ agentIdentity: identity, ttlSeconds: 3600 });
      res.json({
        token,
        identity,
        expiresIn,
      });
    } catch (err) {
      logger.error({ err, userId: payload.userId }, "voice-copilot token: mint failed");
      res.status(503).json({ error: "twilio_not_configured" });
    }
  });

  return router;
}
