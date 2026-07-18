import { Server as HttpServer } from "http";
import { Server, Socket } from "socket.io";
import { resolvePrincipal } from "@chatcenter/shared";

let io: Server;

export function initSocket(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    cors: {
      origin: process.env.FRONTEND_URL || "http://localhost:3000",
      credentials: true,
    },
  });

  io.use(async (socket: Socket, next) => {
    const token = socket.handshake.auth.token as string | undefined;
    if (!token) return next(new Error("Authentication required"));
    try {
      // Same resolver the HTTP gate uses: verify against Authentik's JWKS,
      // then resolve the subject to a live GOTCHA user. A socket must not be
      // an easier way in than a request.
      (socket as any).user = await resolvePrincipal(token);
      next();
    } catch {
      next(new Error("Invalid token"));
    }
  });

  io.on("connection", (socket: Socket) => {
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
