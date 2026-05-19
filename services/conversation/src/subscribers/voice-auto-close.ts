/**
 * Auto-close VOICE conversations when their underlying voice session ends.
 *
 * Listens for `voice.session.ended` (the canonical event fired by
 * voice-copilot's StreamRouter / reaper) and closes the linked Conversation
 * via the standard close() service path so the rest of the system (post-call
 * pipeline, CRM sync, UI inbox) sees the same shape it sees for chat closes.
 *
 * This is the backend safety net for the close-on-hangup behavior — the
 * frontend optimistically calls /api/conversations/:id/close in the workspace
 * page, but browser-closed / dropped / server-killed paths still need a
 * close, and that's what this subscriber catches.
 */
import { prisma, type ServiceEvent } from "@chatcenter/shared";
import { close as closeConversation } from "../services/conversation.service";

interface VoiceEndedPayload {
  sessionId?: string;
  conversationId?: string;
  callSid?: string;
}

export async function handleVoiceSessionEnded(event: ServiceEvent): Promise<void> {
  if (event.event !== "voice.session.ended") return;
  const data = (event.data ?? {}) as VoiceEndedPayload;
  const tenantId = event.tenantId;
  if (!tenantId) return;

  let conversationId = data.conversationId;
  if (!conversationId && data.sessionId) {
    const session = await prisma.voiceCallSession
      .findUnique({ where: { id: data.sessionId }, select: { conversationId: true } })
      .catch(() => null);
    conversationId = session?.conversationId;
  }
  if (!conversationId && data.callSid) {
    const session = await prisma.voiceCallSession
      .findUnique({ where: { callSid: data.callSid }, select: { conversationId: true } })
      .catch(() => null);
    conversationId = session?.conversationId;
  }
  if (!conversationId) return;

  const conv = await prisma.conversation
    .findFirst({
      where: { id: conversationId, tenantId },
      select: { id: true, channel: true, status: true },
    })
    .catch(() => null);
  if (!conv) return;
  if (conv.channel !== "VOICE") return;
  if (conv.status === "CLOSED") return;

  try {
    await closeConversation(tenantId, conv.id);
  } catch (err) {
    console.warn(
      "[voice-auto-close] close failed:",
      (err as { message?: string })?.message ?? err,
    );
  }
}
