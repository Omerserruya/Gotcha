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
  });

  socket.on("disconnect", () => {
    console.log("Socket disconnected");
  });

  return socket;
}

export function getSocket(): Socket | null {
  return socket;
}

export function disconnectSocket(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
