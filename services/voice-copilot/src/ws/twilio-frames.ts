import { z } from "zod";
import crypto from "crypto";

// ---------------------------------------------------------------------------
// Frame schemas
// ---------------------------------------------------------------------------

export const connectedFrame = z.object({
  event: z.literal("connected"),
  protocol: z.string(),
  version: z.string(),
});

export const startFrame = z.object({
  event: z.literal("start"),
  sequenceNumber: z.string(),
  start: z.object({
    streamSid: z.string(),
    accountSid: z.string().optional(),
    callSid: z.string(),
    tracks: z.array(z.string()),
    customParameters: z.record(z.string(), z.string()).optional(),
    mediaFormat: z
      .object({
        encoding: z.string(),
        sampleRate: z.number(),
        channels: z.number(),
      })
      .optional(),
  }),
  streamSid: z.string(),
});

export const mediaFrame = z.object({
  event: z.literal("media"),
  sequenceNumber: z.string(),
  media: z.object({
    track: z.string(),
    chunk: z.string().optional(),
    timestamp: z.string(),
    payload: z.string(),
  }),
  streamSid: z.string(),
});

export const markFrame = z.object({
  event: z.literal("mark"),
  sequenceNumber: z.string(),
  mark: z.object({ name: z.string() }),
  streamSid: z.string(),
});

export const stopFrame = z.object({
  event: z.literal("stop"),
  sequenceNumber: z.string(),
  stop: z
    .object({
      accountSid: z.string().optional(),
      callSid: z.string().optional(),
    })
    .optional(),
  streamSid: z.string(),
});

export const twilioFrame = z.discriminatedUnion("event", [
  connectedFrame,
  startFrame,
  mediaFrame,
  markFrame,
  stopFrame,
]);

export type TwilioFrame = z.infer<typeof twilioFrame>;
export type MediaFrameParsed = z.infer<typeof mediaFrame>;
export type StartFrameParsed = z.infer<typeof startFrame>;

// ---------------------------------------------------------------------------
// Signature validation
// ---------------------------------------------------------------------------

/**
 * Validates the X-Twilio-Signature HMAC-SHA1 header.
 * For WebSocket upgrades, Twilio signs the full URL with no POST params.
 */
export function validateTwilioSignature(
  signature: string | undefined,
  fullUrl: string,
  authToken: string,
  params: Record<string, string> = {}
): boolean {
  if (!signature) return false;
  const sortedKeys = Object.keys(params).sort();
  const canonical = fullUrl + sortedKeys.map((k) => k + params[k]).join("");
  const expected = crypto
    .createHmac("sha1", authToken)
    .update(canonical)
    .digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
