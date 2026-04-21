import pino from "pino";

export type Logger = pino.Logger;

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  base: { service: "voice-copilot" },
  redact: {
    paths: [
      "*.authorization",
      "*.auth",
      "*.apiKey",
      "*.token",
      "req.headers.authorization",
      'req.headers["x-twilio-signature"]',
      'req.headers["x-internal-key"]',
      "media.payload",
      "*.pcm",
      "*.mulaw",
    ],
    censor: "[REDACTED]",
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export function childLogger(ctx: {
  tenantId?: string;
  conversationId?: string;
  callSid?: string;
  streamSid?: string;
}): Logger {
  return logger.child(ctx);
}
