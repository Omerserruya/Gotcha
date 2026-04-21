/**
 * POST /api/voice-copilot/token
 *
 * Mints a short-lived Twilio AccessToken (Voice grant) for a logged-in agent.
 * The browser uses this token to register a Twilio Device, which places
 * outbound calls via TWILIO_TWIML_APP_SID.
 */
import { Router, Request, Response } from "express";
import twilio from "twilio";
import { verifyToken } from "@chatcenter/shared";
import type { Env } from "../config/env";
import type { Logger } from "../lib/logger";

export function createTwilioTokenRouter(opts: { env: Env; logger: Logger }): Router {
  const router = Router();
  const { env, logger } = opts;

  router.post("/", (req: Request, res: Response) => {
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

    if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_API_KEY_SID || !env.TWILIO_API_KEY_SECRET || !env.TWILIO_TWIML_APP_SID) {
      logger.warn({ payload: { userId: payload.userId } }, "voice-copilot token requested but Twilio is not configured");
      res.status(503).json({ error: "twilio_not_configured" });
      return;
    }

    const AccessToken = twilio.jwt.AccessToken;
    const VoiceGrant = AccessToken.VoiceGrant;

    const identity = `agent_${payload.userId}`;
    const token = new AccessToken(
      env.TWILIO_ACCOUNT_SID,
      env.TWILIO_API_KEY_SID,
      env.TWILIO_API_KEY_SECRET,
      { identity, ttl: 3600 }
    );

    const voiceGrant = new VoiceGrant({
      outgoingApplicationSid: env.TWILIO_TWIML_APP_SID,
      incomingAllow: false,
    });
    token.addGrant(voiceGrant);

    res.json({
      token: token.toJwt(),
      identity,
      expiresIn: 3600,
    });
  });

  return router;
}
