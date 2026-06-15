import { publishEvent } from "@chatcenter/shared";
import { channelOf, type ChannelTarget } from "./channels";

/**
 * Wrapper around `publishEvent` that REQUIRES an explicit routing target.
 *
 * Carries `target.channel` inside `data` so any downstream Socket.IO bridge
 * can route to the right room (per-conversation, per-agent, or
 * tenant-admin). Eliminates accidental tenant-wide broadcasts of agent-only
 * events like coaching hints.
 *
 * The bus envelope `{event, tenantId, data}` is unchanged - we only
 * augment `data` with the resolved channel string.
 */
export async function publishConvEvent(
  target: ChannelTarget,
  event: string,
  payload: {
    tenantId: string;
    conversationId?: string;
    [key: string]: unknown;
  },
): Promise<void> {
  const channel = channelOf(target);
  await publishEvent({
    event,
    tenantId: payload.tenantId,
    data: {
      ...payload,
      channel,
    },
  });
}
