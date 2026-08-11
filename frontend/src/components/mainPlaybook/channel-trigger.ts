/**
 * Connecting a channel should put its trigger on the canvas for you.
 *
 * Before this, a merchant connected WhatsApp and then opened the builder to a
 * blank sheet (or a template gallery) with no hint that the first thing they
 * owed it was a Channel Entry bound to the channel they had just connected.
 * The Channels page even had a deep link that centred on that entry node - it
 * just silently did nothing when no such node existed yet.
 *
 * Pure functions over plain node objects: no React, no React Flow, so the
 * seeding rules are unit-testable and the editor only has to place the result.
 */
import { TRIGGER_COLUMN_X } from "./connection-rules";

export interface ChannelLike {
  id: string;
  channel?: string | null;
  displayName?: string | null;
  externalId?: string | null;
  connectionStatus?: string | null;
  isActive?: boolean | null;
}

export interface CanvasNodeLike {
  id: string;
  type?: string;
  position: { x: number; y: number };
  data?: any;
}

/** Vertical pitch between stacked trigger cards in the trigger column. */
export const TRIGGER_ROW_GAP = 220;

/** Normalized channel type, the value channel_entry nodes store and match on. */
export function channelTypeOf(c: ChannelLike | null | undefined): string {
  return String(c?.channel ?? "").toLowerCase();
}

/**
 * A channel worth putting on the canvas. PENDING channels are deliberately
 * included: a WhatsApp number can be receiving messages while Meta still
 * blocks sending, and a merchant in that state very much needs a flow.
 */
export function isSeedableChannel(c: ChannelLike): boolean {
  if (!c?.id || !channelTypeOf(c)) return false;
  if (c.isActive === false) return false;
  const status = String(c.connectionStatus ?? "").toUpperCase();
  return status === "CONNECTED" || status === "PENDING";
}

/**
 * The existing entry node for a channel, if the author already has one.
 * Matched by channel id first, then by channel type - a canvas authored before
 * channels carried ids, or a template's generic "on WhatsApp" entry, still
 * counts, because seeding a second one would give the author two entries that
 * both claim the same inbound traffic.
 */
export function findChannelTrigger(
  nodes: CanvasNodeLike[],
  channel: ChannelLike,
): CanvasNodeLike | undefined {
  const type = channelTypeOf(channel);
  return (
    nodes.find((n) => n.type === "channel_entry" && n.data?.channelId && n.data.channelId === channel.id) ??
    nodes.find((n) => n.type === "channel_entry" && String(n.data?.channelType ?? "").toLowerCase() === type)
  );
}

/** The node data a channel_entry carries for a given channel. */
export function channelTriggerData(channel: ChannelLike): Record<string, unknown> {
  return {
    channelId: channel.id,
    channelType: channelTypeOf(channel),
    label: channel.displayName || channel.externalId || "",
    connected: true,
  };
}

/**
 * The trigger nodes to ADD for these channels: one per seedable channel that
 * has no entry node yet, stacked down the trigger column below whatever is
 * already there. Returns only the new nodes, so the caller appends and never
 * disturbs the author's existing graph.
 */
export function seedChannelTriggers(
  nodes: CanvasNodeLike[],
  channels: ChannelLike[],
  makeId: (index: number) => string,
): CanvasNodeLike[] {
  if (!Array.isArray(channels)) return [];

  const existingTriggerYs = nodes
    .filter((n) => n.type === "channel_entry")
    .map((n) => n.position?.y ?? 0);
  let nextY = existingTriggerYs.length ? Math.max(...existingTriggerYs) + TRIGGER_ROW_GAP : 0;

  const added: CanvasNodeLike[] = [];
  const seen = new Set<string>();

  for (const channel of channels) {
    if (!isSeedableChannel(channel)) continue;
    // Two accounts on the same platform each get their own entry, but the same
    // account arriving twice in the list must not.
    if (seen.has(channel.id)) continue;
    if (findChannelTrigger([...nodes, ...added], channel)) continue;
    seen.add(channel.id);
    added.push({
      id: makeId(added.length),
      type: "channel_entry",
      position: { x: TRIGGER_COLUMN_X, y: nextY },
      data: channelTriggerData(channel),
    });
    nextY += TRIGGER_ROW_GAP;
  }
  return added;
}
