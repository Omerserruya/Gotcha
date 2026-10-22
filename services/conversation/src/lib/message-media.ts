// Deep import: the pure rule, because this service's tests mock the barrel.
import { presentMediaUrl } from "@chatcenter/shared/src/lib/media-url";

type MediaCarrier = { id?: string; conversationId?: string | null; mediaUrl?: string | null };

/**
 * A message as it leaves this service: a stored "/api/uploads/<name>" becomes
 * the logged-in per-message media route, here and on its quoted message (which
 * is always in the same conversation). The DB keeps the stored value
 * (2026-10-10, uploads plan step 2); Meta CDN and other links pass through.
 */
export function presentMessageMedia<M extends MediaCarrier & { replyTo?: MediaCarrier | null }>(m: M): M {
  if (!m || typeof m !== "object") return m;
  const conversationId = m.conversationId;
  const url = presentMediaUrl(m.mediaUrl, { conversationId, messageId: m.id });
  const reply = m.replyTo;
  const replyUrl = reply ? presentMediaUrl(reply.mediaUrl, { conversationId, messageId: reply.id }) : undefined;
  // Unchanged rows go out as the same object.
  if (url === m.mediaUrl && (!reply || replyUrl === reply.mediaUrl)) return m;
  return {
    ...m,
    mediaUrl: url,
    ...(reply && replyUrl !== reply.mediaUrl ? { replyTo: { ...reply, mediaUrl: replyUrl } } : {}),
  };
}

/**
 * A bus event relayed to sockets (incoming-worker's message:new) carries the
 * message with its stored "/api/uploads/..." path: present it here as every
 * read in this service does, so a live push never shows the old public path
 * (2026-10-10). Mutates the event's data in place; anything else untouched.
 */
export function presentRelayedMessage(data: unknown): void {
  if (!data || typeof data !== "object") return;
  const d = data as { message?: unknown };
  const msg = d.message as MediaCarrier | undefined;
  if (msg && typeof msg === "object" && typeof msg.mediaUrl === "string") d.message = presentMessageMedia(msg);
}
