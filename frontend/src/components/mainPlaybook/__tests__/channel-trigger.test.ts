/**
 * "make when user connect channel that set auto as trigger"
 *
 * The rules that matter here are about NOT doing damage: seeding must never
 * give an author two entry nodes competing for the same inbound traffic, and
 * must never touch the graph they already drew.
 */
import { describe, it, expect } from "vitest";
import {
  seedChannelTriggers,
  findChannelTrigger,
  isSeedableChannel,
  channelTriggerData,
  TRIGGER_ROW_GAP,
} from "../channel-trigger";
import { TRIGGER_COLUMN_X } from "../connection-rules";

const wa = { id: "ch_wa", channel: "WHATSAPP", displayName: "Gotcha App", connectionStatus: "CONNECTED", isActive: true };
const ig = { id: "ch_ig", channel: "instagram", displayName: "@gotcha", connectionStatus: "CONNECTED", isActive: true };
const id = (i: number) => `seed_${i}`;

describe("which channels get a trigger", () => {
  it("seeds a connected channel", () => {
    expect(isSeedableChannel(wa)).toBe(true);
  });

  it("seeds a PENDING channel too", () => {
    // A WhatsApp number can be receiving while Meta blocks sending. That
    // merchant needs a flow more than anyone.
    expect(isSeedableChannel({ ...wa, connectionStatus: "PENDING" })).toBe(true);
  });

  it("skips disconnected, errored and deactivated channels", () => {
    expect(isSeedableChannel({ ...wa, connectionStatus: "DISCONNECTED" })).toBe(false);
    expect(isSeedableChannel({ ...wa, connectionStatus: "ERROR" })).toBe(false);
    expect(isSeedableChannel({ ...wa, isActive: false })).toBe(false);
  });

  it("skips a row with no channel type or id to bind to", () => {
    expect(isSeedableChannel({ id: "x", channel: "" })).toBe(false);
    expect(isSeedableChannel({ id: "", channel: "whatsapp" })).toBe(false);
  });
});

describe("seedChannelTriggers", () => {
  it("creates one entry per channel, in the trigger column", () => {
    const added = seedChannelTriggers([], [wa, ig], id);
    expect(added).toHaveLength(2);
    expect(added.every((n) => n.type === "channel_entry")).toBe(true);
    expect(added.every((n) => n.position.x === TRIGGER_COLUMN_X)).toBe(true);
    expect(added[1].position.y - added[0].position.y).toBe(TRIGGER_ROW_GAP);
  });

  it("binds the entry to the channel, lowercased the way the executor matches", () => {
    // flow-executor matches n.data.channelType against the inbound channel in
    // lower case; seeding "WHATSAPP" verbatim would never fire.
    expect(channelTriggerData(wa)).toMatchObject({
      channelId: "ch_wa",
      channelType: "whatsapp",
      label: "Gotcha App",
      connected: true,
    });
  });

  it("does not duplicate an entry the author already has for that channel", () => {
    const existing = [{ id: "n1", type: "channel_entry", position: { x: 0, y: 0 }, data: { channelId: "ch_wa" } }];
    expect(seedChannelTriggers(existing, [wa], id)).toEqual([]);
  });

  it("treats a type-only entry (older canvas, or a template's) as already there", () => {
    const existing = [{ id: "n1", type: "channel_entry", position: { x: 0, y: 0 }, data: { channelType: "whatsapp" } }];
    expect(seedChannelTriggers(existing, [wa], id)).toEqual([]);
  });

  it("does not seed the same channel twice within one pass", () => {
    expect(seedChannelTriggers([], [wa, { ...wa }], id)).toHaveLength(1);
  });

  it("stacks below the triggers already on the canvas instead of on top of them", () => {
    const existing = [{ id: "n1", type: "channel_entry", position: { x: 0, y: 400 }, data: { channelType: "sms" } }];
    const [added] = seedChannelTriggers(existing, [wa], id);
    expect(added.position.y).toBe(400 + TRIGGER_ROW_GAP);
  });

  it("returns only additions, never a rewritten graph", () => {
    const existing = [{ id: "keep", type: "send_message_text", position: { x: 500, y: 0 }, data: { text: "hi" } }];
    const frozen = JSON.stringify(existing);
    seedChannelTriggers(existing, [wa], id);
    expect(JSON.stringify(existing)).toBe(frozen);
  });

  it("survives a missing or malformed channel list", () => {
    expect(seedChannelTriggers([], [] as never, id)).toEqual([]);
    expect(seedChannelTriggers([], null as never, id)).toEqual([]);
  });
});

describe("findChannelTrigger", () => {
  it("prefers the node bound to the exact channel id", () => {
    const nodes = [
      { id: "byType", type: "channel_entry", position: { x: 0, y: 0 }, data: { channelType: "whatsapp" } },
      { id: "byId", type: "channel_entry", position: { x: 0, y: 200 }, data: { channelId: "ch_wa", channelType: "whatsapp" } },
    ];
    expect(findChannelTrigger(nodes, wa)?.id).toBe("byId");
  });

  it("finds nothing for a channel with no entry node", () => {
    expect(findChannelTrigger([], wa)).toBeUndefined();
  });
});
