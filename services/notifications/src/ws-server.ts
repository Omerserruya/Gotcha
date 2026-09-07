/**
 * WebSocket gateway for in-app notifications.
 *
 *   Frontend opens  wss://host/ws?ticket=<single-use handshake ticket>
 *   Server redeems the ticket → records (userId, tenantId) for the socket
 *   (legacy: ?token=<jwt>, still accepted, still verified against JWKS)
 *   Server subscribes to the shared Redis bus for `notification:created`
 *   On match (tenantId + userId) → push `{type:"notification.new",data:...}`
 *
 * Multiple notifications-service replicas can run side-by-side: each replica
 * only knows about its own connected sockets, but every replica receives
 * every Redis pub/sub message. A given user is connected to exactly one
 * replica at a time, so there's no fan-out duplication.
 */
import type { Server as HttpServer, IncomingMessage } from "http";
import type { Duplex } from "stream";
import { WebSocketServer, WebSocket } from "ws";
import {
  resolvePrincipal,
  redeemRealtimeTicket,
  subscribeToEvents,
  type ServiceEvent,
} from "@chatcenter/shared";

interface Client {
  ws: WebSocket;
  userId: string;
  tenantId: string;
}

let _started = false;

export function startNotificationWsServer(httpServer: HttpServer): void {
  if (_started) return;
  _started = true;

  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<Client>();

  httpServer.on("upgrade", async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!req.url || !req.url.startsWith("/ws")) {
      // Not for us - let other listeners handle, or close.
      // No other ws listeners on this server, so reject.
      socket.destroy();
      return;
    }

    let userId: string;
    let tenantId: string;
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

      // ── Handshake ticket (preferred) ──────────────────────
      //
      // A browser cannot set headers on a WebSocket upgrade, so whatever
      // authenticates this connection ends up in the URL. `?token=` put the
      // Authentik ACCESS TOKEN there - into the gateway access log, into any
      // intermediary's, and into browser history - where it stayed valid for
      // its full lifetime. A ticket is minted by an authenticated HTTP request,
      // lives 60 seconds, and is consumed by this redemption, so the copy that
      // reaches a log is already spent.
      //
      // It is also what makes this socket reachable at all under the cookie
      // session model: there is no bearer for client-side JavaScript to read.
      const ticket = url.searchParams.get("ticket");
      if (ticket) {
        const principal = await redeemRealtimeTicket(ticket);
        // No fall-through to `?token=`: a replayed ticket must fail, not
        // quietly become a token-authenticated socket.
        if (!principal) throw new Error("invalid ticket");
        userId = principal.userId;
        tenantId = principal.tenantId;
      } else {
        // ── Access token (legacy) ───────────────────────────
        const token = url.searchParams.get("token");
        if (!token) throw new Error("missing credential");
        // Active-tenant hint (validated against memberships, never trusted raw).
        const payload = await resolvePrincipal(token, url.searchParams.get("tenant"));
        userId = payload.userId;
        tenantId = payload.tenantId;
      }
    } catch (err: any) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const client: Client = { ws, userId, tenantId };
      clients.add(client);

      ws.on("close", () => clients.delete(client));
      ws.on("error", () => { /* swallow - close fires next */ });

      // Optional hello - keeps proxies happy and lets the client confirm.
      try {
        ws.send(JSON.stringify({ type: "hello", data: { userId, tenantId } }));
      } catch { /* ignore */ }
    });
  });

  // Subscribe once per process to the shared Redis bus.
  try {
    subscribeToEvents((evt: ServiceEvent) => {
      if (evt.event !== "notification:created") return;
      const data: any = evt.data || {};
      const targetUserId: string | undefined = data.userId;
      if (!targetUserId) return;

      const frame = JSON.stringify({ type: "notification.new", data });
      for (const c of clients) {
        if (
          c.tenantId === evt.tenantId &&
          c.userId === targetUserId &&
          c.ws.readyState === WebSocket.OPEN
        ) {
          try { c.ws.send(frame); } catch { /* ignore broken socket */ }
        }
      }
    });
    console.log("[notifications.ws] attached at /ws (subscribed to notification:created)");
  } catch (err: any) {
    console.warn("[notifications.ws] subscribe failed:", err?.message);
  }
}
