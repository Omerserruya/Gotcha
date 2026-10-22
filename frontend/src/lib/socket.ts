import { io, Socket } from "socket.io-client";
import { getActiveTenantId } from "./active-tenant";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || "";

let socket: Socket | null = null;

export function connectSocket(token: string): Socket {
  if (socket?.connected) return socket;

  socket = io(WS_URL, {
    // tenantId = the active-tenant hint; the server validates it against the
    // identity's memberships exactly like the HTTP X-Tenant-Id header.
    auth: { token, tenantId: getActiveTenantId() || undefined },
    transports: ["websocket", "polling"],
  });

  socket.on("connect", () => {
    console.log("Socket connected");
    // Rooms live on the server's socket, so a reconnect starts in none of them.
    // Re-send every room this client still believes it is in, or a dropped
    // connection mid-call comes back silent with the socket showing green.
    // Array.from, not a bare iterator: this tsconfig targets below es2015 for
    // iteration and `for (const x of map.keys())` does not compile.
    for (const conversationId of Array.from(roomRefs.keys())) {
      socket?.emit("subscribe:conversation", conversationId);
    }
  });

  socket.on("disconnect", () => {
    console.log("Socket disconnected");
  });

  return socket;
}

export function getSocket(): Socket | null {
  return socket;
}

/**
 * Per-conversation rooms.
 *
 * Live-call events used to arrive simply because you were logged in - the
 * server broadcast every transcript to the whole tenant and each component
 * filtered client-side, which meant the filtering was cosmetic and the data had
 * already been delivered. The server now decides, and a client only receives a
 * conversation it explicitly joined and is entitled to.
 *
 * Refcounted because several components on the voice workspace want the same
 * conversation at once (the call context, the cue recorder, the suggestions
 * card). The first join sends `subscribe:conversation`; the last leave sends
 * `unsubscribe:conversation`. Leaving on the first unmount would silence the
 * components still watching.
 */
const roomRefs = new Map<string, number>();

export function joinConversation(conversationId: string): void {
  if (!conversationId) return;
  const next = (roomRefs.get(conversationId) ?? 0) + 1;
  roomRefs.set(conversationId, next);
  if (next > 1) return;
  const s = getSocket();
  if (!s) {
    // No socket yet. Drop the count back so a later caller re-sends rather
    // than believing a room was joined that never was.
    roomRefs.delete(conversationId);
    return;
  }
  s.emit("subscribe:conversation", conversationId, (res: { ok?: boolean; reason?: string } | undefined) => {
    // The server answers. A refused join is why a live call would show nothing,
    // and without this line it looks identical to a quiet call.
    if (!res?.ok) {
      console.warn(`[socket] conversation subscribe refused: ${conversationId} (${res?.reason ?? "no response"})`);
    }
  });
}

export function leaveConversation(conversationId: string): void {
  if (!conversationId) return;
  const cur = roomRefs.get(conversationId);
  if (!cur) return;
  if (cur > 1) {
    roomRefs.set(conversationId, cur - 1);
    return;
  }
  roomRefs.delete(conversationId);
  getSocket()?.emit("unsubscribe:conversation", conversationId);
}

export function disconnectSocket(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  // A new socket is in no rooms and the old counts describe nothing. Left
  // behind, they would make the next join a no-op because the count was
  // already above zero.
  roomRefs.clear();
}
