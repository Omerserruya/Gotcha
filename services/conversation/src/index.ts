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
import identityRoutes from "./routes/identity";
import approvalRoutes from "./routes/approvals";
import audienceRoutes from "./routes/audiences";
import tenantSettingsRoutes from "./routes/tenant-settings";
import voiceSessionsRoutes from "./routes/voice-sessions";
import voiceChannelsRoutes from "./routes/voice-channels";
import autoBuyRoutes from "./routes/auto-buy";
import { handleVoiceSessionEnded } from "./subscribers/voice-auto-close";
import { relayToVisitor, relayConversationState } from "./subscribers/shopify-visitor-relay";

const config = { name: "conversation-service", port: parseInt(process.env.PORT || "4002", 10) };
const app = createServiceApp(config);
const httpServer = createServer(app);

// Initialize Socket.IO
initSocket(httpServer);

// Subscribe to cross-service events and relay to Socket.IO.
// This is pure projection — no side effects, no DB writes. Voice-copilot
// writes final VOICE-channel messages directly to Postgres via its
// StreamRouter.PersistenceSink; we only forward the events to browsers.
subscribeToEvents((event) => {
  try {
    const io = getIO();
    io.to(`tenant:${event.tenantId}`).emit(event.event, event.data);
  } catch {
    // Socket not ready yet — event is dropped (acceptable per MVP spec)
  }
});

// Shopify Live Chat: project the same events into the storefront
// visitor's own room. Reuses this transport instead of adding a second
// one; the projection strips everything a shopper must not see.
subscribeToEvents((event) => {
  relayToVisitor(event).catch((err) => {
    console.warn("[shopify-visitor-relay] threw:", (err as { message?: string })?.message ?? err);
  });
  relayConversationState(event);
});

// Backend safety net: when a voice session ends (browser close, drop, reaper),
// close the linked conversation so it doesn't stay OPEN in the inbox. The
// frontend also closes optimistically on the hangup button — both paths are
// idempotent because close() is a no-op when status === "CLOSED".
subscribeToEvents((event) => {
  handleVoiceSessionEnded(event).catch((err) => {
    console.warn("[voice-auto-close] handler threw:", (err as { message?: string })?.message ?? err);
  });
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
app.use("/api/identity", identityRoutes);
app.use("/api/approvals", approvalRoutes);
app.use("/api/audiences", audienceRoutes);
app.use("/api/tenant-settings", tenantSettingsRoutes);
app.use("/api/voice-sessions", voiceSessionsRoutes);
app.use("/api/voice-channels", voiceChannelsRoutes);
app.use("/api/auto-buy", autoBuyRoutes);

// NOTE: Outgoing message worker has been extracted to @chatcenter/outgoing-worker service
// for independent scaling. This service is now API + WebSocket only.

httpServer.listen(config.port, () => {
  console.log(`[${config.name}] running on port ${config.port}`);
});

export { app, httpServer };
