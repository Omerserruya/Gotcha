import { Server as HttpServer } from "http";
import { Server, Socket } from "socket.io";
import crypto from "crypto";
import { prisma, resolvePrincipal, verifyVisitorSession, redeemRealtimeTicket } from "@chatcenter/shared";
import { canViewConversation } from "./conversation-visibility";

let io: Server;

/**
 * Storefront visitors connect from the merchant's own domain, so the
 * socket CORS allowlist can no longer be just the dashboard. We accept
 * any origin at the handshake and rely on the token check below for
 * authorisation - a connection with no valid token joins no room and
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

    // ── Staff, by handshake ticket ─────────────────────────
    //
    // Preferred over `auth.token` and checked first. The ticket was minted by
    // an authenticated HTTP request (POST /api/realtime/ticket), lives 60
    // seconds, and is destroyed by this redemption - so a browser holding only
    // an HttpOnly cookie can still open a socket, and nothing long-lived is
    // handed to client-side JavaScript to do it.
    const ticket = auth.ticket as string | undefined;
    if (ticket) {
      const principal = await redeemRealtimeTicket(ticket);
      // A ticket that does not redeem is a hard failure. Falling back to
      // `auth.token` here would mean a replayed ticket silently becomes a
      // token-authenticated socket, which is the opposite of single-use.
      if (!principal) return next(new Error("Invalid or expired ticket"));
      (socket as any).user = principal;
      (socket as any).kind = "staff";
      return next();
    }

    // ── Staff, by access token (legacy) ────────────────────
    const token = auth.token as string | undefined;
    if (token) {
      try {
        // Same resolver the HTTP gate uses: verify against Authentik's JWKS,
        // then resolve the subject to a live GOTCHA user. A socket must not be
        // an easier way in than a request. The active-tenant hint is validated
        // against the identity's memberships, exactly like the HTTP header.
        //
        // Kept over the verifyToken() this branch arrived with: that is the
        // pre-Authentik local-signing path, and restoring it here would put a
        // second, weaker front door on the same building.
        const tenantHint = (auth.tenantId as string | undefined) || null;
        (socket as any).user = await resolvePrincipal(token, tenantHint);
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

    // ── Website widget visitor (web chat) ──────────────────
    //
    // The same secret the web chat's REST routes take: the session token the
    // widget got from /init, which IS the conversation's customerExternalId.
    // One web chat conversation, the same single room as above.
    const webchatToken = auth.webchatToken as string | undefined;
    if (webchatToken) {
      const conversationId = String(auth.conversationId ?? "");
      if (!conversationId || typeof webchatToken !== "string") return next(new Error("Conversation required"));
      try {
        const c = await prisma.conversation.findUnique({
          where: { id: conversationId },
          select: { id: true, tenantId: true, channel: true, customerExternalId: true },
        });
        const a = Buffer.from(String(c?.customerExternalId ?? ""));
        const b = Buffer.from(webchatToken);
        if (!c || c.channel !== "WEBCHAT" || !c.customerExternalId || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
          return next(new Error("Conversation not found"));
        }
        (socket as any).visitor = { tenantId: c.tenantId, conversationId: c.id };
        (socket as any).kind = "visitor";
        return next();
      } catch {
        return next(new Error("Conversation lookup failed"));
      }
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
    // `agent:{userId}` is the same person as `user:{userId}` under the name the
    // event bus uses (`channels.agent`). Both are joined because the bridge now
    // routes by the publisher's own target string, and `copilot.cues.updated`
    // - which the cue lanes, the right panel and the replay recorder all listen
    // to - is published at an agent target. Without this join that target
    // resolves to an empty room and the cues go dark with the socket still
    // connected, which is exactly the silent failure this change is about.
    // The two names should be unified; doing it here would mean renaming a room
    // that other code already emits to, so it is left as its own change.
    socket.join(`agent:${user.userId}`);

    // ── Per-conversation rooms ─────────────────────────────
    //
    // The tenant room is a broadcast to everyone logged in. Anything scoped to
    // ONE conversation - a live call transcript above all - must not go there,
    // so the client asks to join the conversation it is actually on and the
    // server decides whether it may.
    //
    // Entitlement is evaluated HERE, once, and never per event: transcripts
    // arrive as partials several times a second and a database round trip per
    // syllable is not affordable. Same shape as the visitor room above, which
    // is described in this file as "the whole isolation guarantee".
    //
    // The ack is deliberate. A client that silently fails to join looks exactly
    // like a call with nothing to say, which is the failure mode this whole
    // change exists to avoid.
    socket.on("subscribe:conversation", async (raw: unknown, ack?: (r: unknown) => void) => {
      const conversationId = typeof raw === "string" ? raw : String((raw as any)?.conversationId ?? "");
      if (!conversationId) {
        ack?.({ ok: false, reason: "conversation_required" });
        return;
      }
      try {
        const allowed = await canViewConversation(user.tenantId, conversationId, {
          userId: user.userId,
          role: user.role,
          departmentId: user.departmentId,
        });
        if (!allowed) {
          // Same answer for "not yours" and "does not exist". A caller must not
          // be able to probe which conversation ids are real.
          ack?.({ ok: false, reason: "not_permitted" });
          return;
        }
        socket.join(`conv:${conversationId}`);
        ack?.({ ok: true });
      } catch {
        ack?.({ ok: false, reason: "lookup_failed" });
      }
    });

    socket.on("unsubscribe:conversation", (raw: unknown) => {
      const conversationId = typeof raw === "string" ? raw : String((raw as any)?.conversationId ?? "");
      if (conversationId) socket.leave(`conv:${conversationId}`);
    });

    socket.on("disconnect", () => {});
  });

  return io;
}

export function getIO(): Server {
  if (!io) throw new Error("Socket.IO not initialized");
  return io;
}
