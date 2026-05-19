import { prisma, parseCopilotConfig, EMPTY_COPILOT_CONFIG, type CopilotConfig } from "@chatcenter/shared";

/**
 * Look up the per-channel Copilot config for a conversation.
 *
 * Chain: Conversation → channelId → CommunicationChannel → VoiceChannel.
 * Returns an empty config when nothing is configured so the live runner can
 * always fall through to platform defaults.
 *
 * Cached for the duration of a live call via the runner's lifecycle — the
 * supervisor calls this exactly once when the runner spins up.
 */
export async function loadCopilotConfigForConversation(
  conversationId: string,
): Promise<CopilotConfig> {
  try {
    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { channelId: true },
    });
    if (!conv?.channelId) return EMPTY_COPILOT_CONFIG;

    const voiceChannel = await prisma.voiceChannel.findFirst({
      where: { communicationChannelId: conv.channelId },
      select: { copilotConfig: true },
    });
    if (!voiceChannel) return EMPTY_COPILOT_CONFIG;

    return parseCopilotConfig(voiceChannel.copilotConfig);
  } catch (err) {
    console.warn(
      "[copilot-config-loader] lookup failed, using defaults:",
      (err as { message?: string })?.message ?? err,
    );
    return EMPTY_COPILOT_CONFIG;
  }
}
