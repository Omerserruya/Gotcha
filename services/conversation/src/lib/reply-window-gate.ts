import { hasReplyWindow, lastInboundAtForRecipient, replyWindowFor, sendAllowed, type ReplyWindow } from "@chatcenter/shared";

/**
 * Before an agent's free-text or media reply is written (B7, 2026-10-12): may
 * it be sent through this conversation's customer-service window? A refusal is
 * a 409 the composer can act on: TEMPLATE_REQUIRED (WhatsApp, send a template)
 * or REPLY_WINDOW_CLOSED (Instagram/Messenger, nothing until the customer
 * writes), with the window itself. Nothing is stored for a refused send.
 *
 * Fails open: if the window cannot be read, the reply goes ahead and the
 * outgoing worker (and Meta) still decide.
 */
export async function replyWindowRefusal(conversation: {
  tenantId: string;
  channel: string | null;
  channelAccountId: string | null;
  customerExternalId: string;
}): Promise<{ status: 409; body: { error: string; code: string; replyWindow: ReplyWindow } } | null> {
  try {
    const channel = conversation.channel || "WHATSAPP";
    if (!hasReplyWindow(channel)) return null;
    const last = await lastInboundAtForRecipient({
      tenantId: conversation.tenantId,
      channel,
      channelAccountId: conversation.channelAccountId,
      customerExternalId: conversation.customerExternalId,
    });
    const window = replyWindowFor(channel, last);
    // This route sends free text or media, never a template (that is
    // POST /:id/messages/template), whatever messageType the client claims.
    const verdict = sendAllowed(window, "text");
    if (verdict.ok) return null;
    return { status: 409, body: { error: verdict.message, code: verdict.code, replyWindow: window } };
  } catch (err: any) {
    console.warn(`[reply-window] unreadable, allowing the reply: ${err?.message}`);
    return null;
  }
}
