import { Server as HttpServer } from "http";
import { Server, Socket } from "socket.io";
import { prisma, verifyToken, verifyVisitorSession } from "@chatcenter/shared";

let io: Server;

/**
 * Storefront visitors connect from the merchant's own domain, so the
 * socket CORS allowlist can no longer be just the dashboard. We accept
 * any origin at the handshake and rely on the token check below for
 * authorisation — a connection with no valid token joins no room and
 * therefore receives nothing.
 */
export function initSocket(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    cors: {
      origin: (origin, cb) => cb(null, origin ?? true),
      credentials: true,
    },
  });

  io.use(async (socket: Socket, next) => {
    const auth = socket.handshake.auth ?? {};

    // ── Staff ──────────────────────────────────────────────
    const token = auth.token as string | undefined;
    if (token) {
      try {
        (socket as any).user = verifyToken(token);
        (socket as any).kind = "staff";
        return next();
      } catch {
        return next(new Error("Invalid token"));
      }
    }

    // ── Storefront visitor ─────────────────────────────────
    //
    // A visitor is scoped to exactly ONE conversation room. The token
    // proves tenant + visitor identity; the conversation id is supplied
    // separately and must be verifiably theirs, so a visitor cannot
    // subscribe to somebody else's chat by guessing an id.
    const visitorToken = auth.visitorToken as string | undefined;
    if (visitorToken) {
      const session = verifyVisitorSession(visitorToken);
      if (!session) return next(new Error("Invalid visitor session"));
      const conversationId = String(auth.conversationId ?? "");
      if (!conversationId) return next(new Error("Conversation required"));
      try {
        const conversation = await prisma.conversation.findFirst({
          where: {
            id: conversationId,
            tenantId: session.tenantId,
            channelAccountId: session.channelAccountId,
            customerExternalId: session.visitorId,
          },
          select: { id: true },
        });
        if (!conversation) return next(new Error("Conversation not found"));
      } catch {
        return next(new Error("Conversation lookup failed"));
      }
      (socket as any).visitor = { ...session, conversationId };
      (socket as any).kind = "visitor";
      return next();
    }

    return next(new Error("Authentication required"));
  });

  io.on("connection", (socket: Socket) => {
    if ((socket as any).kind === "visitor") {
      const visitor = (socket as any).visitor;
      // ONE room, and nothing tenant-wide. This is the whole isolation
      // guarantee for the public side of the socket.
      socket.join(`visitor:${visitor.conversationId}`);
      socket.on("disconnect", () => {});
      return;
    }
    const user = (socket as any).user;
    socket.join(`tenant:${user.tenantId}`);
    socket.join(`user:${user.userId}`);
    socket.on("disconnect", () => {});
  });

  return io;
}

export function getIO(): Server {
  if (!io) throw new Error("Socket.IO not initialized");
  return io;
}
