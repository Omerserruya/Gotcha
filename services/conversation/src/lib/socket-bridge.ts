import type { Server } from "socket.io";
import { presentRelayedMessage } from "./message-media";

type BusEvent = { event: string; tenantId: string; data: unknown };

/**
 * The room names a publisher can target, the same set this service's sockets
 * join (lib/socket.ts) plus the builders in services/ai intelligence/events.
 */
const ROOM_TARGET = /^(conv|agent|user|tenant):./;

/**
 * Which room a bus event is for, or null for the tenant room.
 *
 * `data.channel` carries two meanings on this bus. On the routed events it is a
 * room ("conv:<id>"). On message:new and conversation:updated it is the
 * conversation's CHANNEL TYPE ("WHATSAPP", "WEBCHAT"), and the AI subscribers
 * read it that way (copilot-suggestions, intelligence-live). Taking every
 * string as a room sent each inbound message to a room named "WHATSAPP" that
 * no socket joins, so the inbox never saw a customer's message until a refresh
 * (found 2026-10-11). Only a value shaped like a room is a target.
 */
export function roomFor(event: BusEvent): string | null {
  const channel = (event.data as { channel?: unknown } | null)?.channel;
  return typeof channel === "string" && ROOM_TARGET.test(channel) ? channel : null;
}

/**
 * A socket receives `data`, never the bus envelope, so a frame that left its
 * tenant on the envelope arrives without one, and a client that drops frames
 * for another workspace (frontend-v2 socket-transport) drops every one of them.
 * message:new also nests its id under `message`. Both are added here, from the
 * envelope and the message, when the publisher left them out; nothing a
 * publisher set is overwritten. Mutates in place, as presentRelayedMessage does.
 */
export function withIdentity(event: BusEvent): void {
  const d = event.data as Record<string, unknown> | null;
  if (!d || typeof d !== "object" || Array.isArray(d)) return;
  if (d.tenantId === undefined && event.tenantId) d.tenantId = event.tenantId;
  if (event.event === "message:new" && d.messageId === undefined) {
    const id = (d.message as { id?: unknown } | null | undefined)?.id;
    if (typeof id === "string") d.messageId = id;
  }
}

const untargeted = new Set<string>();

/**
 * Relay one bus event to sockets. Pure projection: no side effects, no DB.
 *
 * ROUTING. An event whose `data.channel` names a room goes only there; any
 * other event broadcasts to the tenant room.
 */
export function relayBusEvent(io: Pick<Server, "to">, event: BusEvent): void {
  presentRelayedMessage(event.data);
  withIdentity(event);
  const room = roomFor(event);
  if (room) {
    io.to(room).emit(event.event, event.data);
    return;
  }
  // ONE line per distinct event name per process, not one per event: voice
  // transcripts alone would make this unreadable within a single call. The
  // point is the enumeration - which events still broadcast tenant-wide - and
  // that is a set, not a stream.
  if (!untargeted.has(event.event)) {
    untargeted.add(event.event);
    console.log(`[socket-bridge] untargeted event broadcasts tenant-wide: ${event.event}`);
  }
  io.to(`tenant:${event.tenantId}`).emit(event.event, event.data);
}
