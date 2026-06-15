/**
 * Fire-and-forget hop into the local /api/voice-copilot/callbacks/missed-template
 * endpoint. The endpoint itself is idempotent (writes the message id onto
 * `session.meta.missedTemplateMessageId` on first run and short-circuits on
 * subsequent calls), so over-triggering this is safe.
 *
 * Lives here (rather than inside one route module) because multiple state
 * transitions can land in MISSED - `/status` and `/forward-complete` in
 * voice-incoming.ts, plus conference-end / participant-leave in twilio-twiml.ts.
 * Sharing one helper keeps the template-fire policy consistent across all
 * MISSED entry points.
 */
import type { Logger } from "./logger";

export function fireMissedTemplate(sessionId: string, logger: Logger): void {
  const internalKey = process.env.INTERNAL_SERVICE_KEY || "chatcenter-internal-2026";
  const port = process.env.PORT || "4007";
  void fetch(`http://localhost:${port}/api/voice-copilot/callbacks/missed-template`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Internal-Key": internalKey },
    body: JSON.stringify({ sessionId }),
  }).then(async (r) => {
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      // 409 from the missed-template endpoint means the channel didn't
      // need a template (wrong modes, no WABA channel, etc.) - that's a
      // routine outcome, not a real error.
      if (r.status !== 409) {
        logger.warn({ status: r.status, body: txt.slice(0, 200), sessionId }, "missed-template upstream non-ok");
      }
    }
  }).catch((err) => {
    logger.warn({ err: err?.message, sessionId }, "missed-template upstream threw");
  });
}
