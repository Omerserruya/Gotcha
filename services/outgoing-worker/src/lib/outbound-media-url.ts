// Deep import: the pure rule, matching the other services that deep-import it.
import { signMediaUrl, signedMediaPath, storedUploadName } from "@chatcenter/shared/src/lib/media-url";

/** Long enough for a provider to fetch on the first try and on BullMQ retries. */
export const OUTBOUND_MEDIA_TTL_SECONDS = 15 * 60;

/**
 * The URL a provider (Meta, Slack) fetches an upload from (2026-10-10, uploads
 * plan step 3). A stored "/api/uploads/<name>" becomes a short-lived signed
 * /api/media/s link for this message, signed here at send time so a delayed
 * job still gets a fresh one. A Meta CDN or operator-entered absolute link
 * passes through unchanged.
 *
 * The origin is this worker's PUBLIC_URL when it has one, else the one the
 * producer put on the job (this worker has no PUBLIC_URL in compose today).
 * Without either, the send fails with a reason rather than handing a provider
 * a relative path it cannot fetch.
 */
export function outboundMediaUrl(input: {
  mediaUrl: string;
  messageId: string;
  tenantId: string;
  publicBaseUrl?: string | null;
  now?: number;
}): string {
  if (!storedUploadName(input.mediaUrl)) return input.mediaUrl;
  const base = (process.env.PUBLIC_URL || input.publicBaseUrl || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s/]+(\/\S*)?$/i.test(base)) {
    throw new Error("No public origin configured to send this attachment from");
  }
  const signed = signMediaUrl({
    messageId: input.messageId,
    tenantId: input.tenantId,
    ttlSeconds: OUTBOUND_MEDIA_TTL_SECONDS,
    now: input.now,
  });
  return `${base}${signedMediaPath(input.messageId, signed)}`;
}
