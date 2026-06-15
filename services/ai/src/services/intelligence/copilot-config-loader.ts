import { prisma, parseCopilotConfig, EMPTY_COPILOT_CONFIG, type CopilotConfig } from "@chatcenter/shared";

/**
 * Look up the per-channel Copilot config for a conversation.
 *
 * Chain: Conversation → channelId → CommunicationChannel → VoiceChannel.
 * Returns an empty config when nothing is configured so the live runner can
 * always fall through to platform defaults.
 *
 * Cached for the duration of a live call via the runner's lifecycle - the
 * supervisor calls this exactly once when the runner spins up.
 */
export async function loadCopilotConfigForConversation(
  conversationId: string,
): Promise<CopilotConfig> {
  try {
    // Conversation rows don't carry the CommunicationChannel.id directly -
    // the link is via VoiceCallSession.channelId (set when the call rings
    // in / is placed out). Falls through to defaults when there's no
    // session yet (e.g. very early in the lifecycle).
    const session = await prisma.voiceCallSession.findFirst({
      where: { conversationId },
      select: { channelId: true },
      orderBy: { startedAt: "desc" },
    });
    if (!session?.channelId) return EMPTY_COPILOT_CONFIG;

    const voiceChannel = await prisma.voiceChannel.findFirst({
      where: { communicationChannelId: session.channelId },
      // Phase 6: aiAgentId is now a real FK column. The JSONB still carries
      // legacy goals/persona/questions/dataFields - those remain the
      // fallback for tenants without a funnel. We overlay the FK onto the
      // parsed config so downstream consumers keep reading a uniform shape.
      select: { copilotConfig: true, aiAgentId: true },
    });
    if (!voiceChannel) return EMPTY_COPILOT_CONFIG;

    const parsed = parseCopilotConfig(voiceChannel.copilotConfig);
    if (voiceChannel.aiAgentId) parsed.aiAgentId = voiceChannel.aiAgentId;
    return parsed;
  } catch (err) {
    console.warn(
      "[copilot-config-loader] lookup failed, using defaults:",
      (err as { message?: string })?.message ?? err,
    );
    return EMPTY_COPILOT_CONFIG;
  }
}
