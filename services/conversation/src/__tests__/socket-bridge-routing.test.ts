/**
 * The socket bridge routes a bus event to the room named in `data.channel` -
 * but that field also carries the conversation's CHANNEL TYPE on message:new
 * and conversation:updated. Taken as a room, every inbound WhatsApp message
 * went to a room called "WHATSAPP" that no socket joins, and the inbox showed
 * nothing until a refresh (2026-10-11).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { relayBusEvent, roomFor } from "../lib/socket-bridge";

const sent: Array<{ room: string; event: string; data: any }> = [];
const io = { to: (room: string) => ({ emit: (event: string, data: any) => { sent.push({ room, event, data }); return true; } }) } as any;

beforeEach(() => { sent.length = 0; vi.spyOn(console, "log").mockImplementation(() => {}); });

const inbound = (channel: unknown) => ({
  event: "message:new",
  tenantId: "T1",
  data: { message: { id: "m1", conversationId: "c1", tenantId: "T1", direction: "INBOUND", body: "hi" }, conversationId: "c1", channel },
});

describe("socket bridge routing", () => {
  it("an inbound message carrying its channel TYPE reaches the tenant room", () => {
    for (const type of ["WHATSAPP", "MESSENGER", "INSTAGRAM", "WEBCHAT", "EMAIL", "VOICE", "SHOPIFY_CHAT"]) {
      sent.length = 0;
      relayBusEvent(io, inbound(type));
      expect(sent, type).toEqual([{ room: "tenant:T1", event: "message:new", data: expect.objectContaining({ conversationId: "c1" }) }]);
    }
  });

  it("the channel type stays on the payload for the clients that read it", () => {
    relayBusEvent(io, inbound("WHATSAPP"));
    expect(sent[0].data.channel).toBe("WHATSAPP");
  });

  it("an event naming a room still goes ONLY to that room", () => {
    for (const room of ["conv:c1", "agent:u1", "user:u1", "tenant:T1:admin"]) {
      sent.length = 0;
      relayBusEvent(io, { event: "voice.transcript", tenantId: "T1", data: { conversationId: "c1", channel: room } });
      expect(sent.map((s) => s.room), room).toEqual([room]);
    }
  });

  it("no channel, an empty one, a bare prefix or a non-string: the tenant room", () => {
    for (const channel of [undefined, "", "conv:", null, 42]) {
      expect(roomFor({ event: "x", tenantId: "T1", data: { channel } }), String(channel)).toBeNull();
    }
    expect(roomFor({ event: "x", tenantId: "T1", data: null })).toBeNull();
  });

  it("a stored upload is presented as the logged-in media route on the relayed message", () => {
    const e = inbound("WHATSAPP");
    (e.data.message as any).mediaUrl = "/api/uploads/0b6f8f0e-3c1a-4f7e-9a51-2d4c8e6b7a10.jpg";
    relayBusEvent(io, e);
    expect(sent[0].data.message.mediaUrl).toBe("/api/conversations/c1/messages/m1/media/0b6f8f0e-3c1a-4f7e-9a51-2d4c8e6b7a10.jpg");
  });
});

describe("socket bridge frames carry what a client filters on", () => {
  it("message:new: the envelope's tenant and the message id are on the frame", () => {
    relayBusEvent(io, inbound("WHATSAPP"));
    expect(sent[0].data).toMatchObject({ tenantId: "T1", messageId: "m1", conversationId: "c1" });
  });

  it("message:status from outgoing-worker or the webhook (no tenant in data) gains it", () => {
    relayBusEvent(io, { event: "message:status", tenantId: "T1", data: { messageId: "m1", conversationId: "c1", status: "DELIVERED" } });
    expect(sent[0]).toEqual({ room: "tenant:T1", event: "message:status", data: { messageId: "m1", conversationId: "c1", status: "DELIVERED", tenantId: "T1" } });
  });

  it("nothing a publisher set is overwritten, and messageId is only added to message:new", () => {
    relayBusEvent(io, { event: "message:new", tenantId: "T1", data: { tenantId: "T-publisher", messageId: "keep", message: { id: "m1" }, conversationId: "c1" } });
    relayBusEvent(io, { event: "conversation:updated", tenantId: "T1", data: { id: "c1", message: { id: "m9" }, channel: "WHATSAPP" } });
    expect(sent[0].data.messageId).toBe("keep");
    expect(sent[0].data.tenantId).toBe("T-publisher");
    expect(sent[1].data.messageId).toBeUndefined();
    expect(sent[1].data.tenantId).toBe("T1");
  });

  it("a non-object payload passes through untouched", () => {
    relayBusEvent(io, { event: "ping", tenantId: "T1", data: "x" as any });
    expect(sent[0].data).toBe("x");
  });
});
