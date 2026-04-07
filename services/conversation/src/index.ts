import path from "path";
import express from "express";
import { createServiceApp, startService, subscribeToEvents } from "@chatcenter/shared";
import { createServer } from "http";
import { initSocket, getIO } from "./lib/socket";
import conversationRoutes from "./routes/conversations";
import messageRoutes from "./routes/messages";
import templateRoutes from "./routes/templates";
import broadcastRoutes from "./routes/broadcasts";
import scheduledMessageRoutes from "./routes/scheduled-messages";
import contactRoutes from "./routes/contacts";

const config = { name: "conversation-service", port: parseInt(process.env.PORT || "4002", 10) };
const app = createServiceApp(config);
const httpServer = createServer(app);

// Initialize Socket.IO
initSocket(httpServer);

// Subscribe to cross-service events and relay to Socket.IO
subscribeToEvents((event) => {
  try {
    const io = getIO();
    io.to(`tenant:${event.tenantId}`).emit(event.event, event.data);
  } catch {
    // Socket not ready yet
  }
});

// Serve uploaded media files
const uploadsDir = process.env.UPLOADS_DIR || path.resolve(process.cwd(), "uploads");
app.use("/api/uploads", express.static(uploadsDir));

// Routes
app.use("/api/conversations", conversationRoutes);
app.use("/api/conversations", messageRoutes);
app.use("/api/templates", templateRoutes);
app.use("/api/broadcasts", broadcastRoutes);
app.use("/api/scheduled-messages", scheduledMessageRoutes);
app.use("/api/contacts", contactRoutes);

// NOTE: Outgoing message worker has been extracted to @chatcenter/outgoing-worker service
// for independent scaling. This service is now API + WebSocket only.

httpServer.listen(config.port, () => {
  console.log(`[${config.name}] running on port ${config.port}`);
});

export { app, httpServer };
