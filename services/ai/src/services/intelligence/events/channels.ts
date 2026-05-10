/**
 * Routing channel builders for the conversation intelligence event bus.
 *
 * The audit revealed that `voice.copilot.suggestions` was tenant-broadcast,
 * leaking other agents' coaching to every connected client. Phase 3
 * introduces explicit channels so every new event names its target.
 *
 * Existing events keep firing on the legacy bus shape during Phase 3 for
 * backward compatibility; Phase 4 retires them.
 */

export type ChannelTarget =
  | { kind: "conversation"; id: string }
  | { kind: "agent"; userId: string }
  | { kind: "tenantAdmin"; tenantId: string };

export const channels = {
  conversation: (id: string): string => `conv:${id}`,
  agent: (userId: string): string => `agent:${userId}`,
  tenantAdmin: (tenantId: string): string => `tenant:${tenantId}:admin`,
};

export function channelOf(target: ChannelTarget): string {
  switch (target.kind) {
    case "conversation":
      return channels.conversation(target.id);
    case "agent":
      return channels.agent(target.userId);
    case "tenantAdmin":
      return channels.tenantAdmin(target.tenantId);
  }
}
