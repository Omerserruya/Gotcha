import path from "path";
import express from "express";
import { createServiceApp, startService, subscribeToEvents, probeUploadsDir, describeUploadsProbe, reportOperationalFailure, ERROR_CODES } from "@chatcenter/shared";
import { createServer } from "http";
import { initSocket, getIO } from "./lib/socket";
import conversationRoutes from "./routes/conversations";
import messageRoutes from "./routes/messages";
import templateRoutes from "./routes/templates";
import broadcastRoutes from "./routes/broadcasts";
import scheduledMessageRoutes from "./routes/scheduled-messages";
import contactRoutes from "./routes/contacts";
import gdprContactsRoutes from "./routes/gdpr-contacts";
import identityRoutes from "./routes/identity";
import approvalRoutes from "./routes/approvals";
import audienceRoutes from "./routes/audiences";
import tenantSettingsRoutes from "./routes/tenant-settings";
import businessPolicyRoutes from "./routes/business-policies";
import policyDecisionRoutes from "./routes/policy-decisions";
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
// This is pure projection - no side effects, no DB writes. Voice-copilot
// writes final VOICE-channel messages directly to Postgres via its
// StreamRouter.PersistenceSink; we only forward the events to browsers.
//
// ROUTING. `data.channel` names the room this event is FOR. Events that name
// one go only there; events that do not still broadcast to the tenant.
//
// This bridge used to emit everything to `tenant:{id}` unconditionally, which
// meant the routing targets that publishers had been setting since Phase 3 were
// read by nobody. Nine events declared a conversation or agent target and every
// one of them went to every open tab in the tenant - including `coaching.hint`,
// which is private feedback about one person's performance. The publishers were
// right; nothing was listening.
//
// Note what this means for the obvious version of this fix: moving a publisher
// onto `channels.conversation(id)` accomplishes nothing on its own, because the
// bus envelope has no target field - `publishConvEvent` writes the channel into
// `data` as a hint and THIS is the only code that can honour it.
const untargeted = new Set<string>();
subscribeToEvents((event) => {
  try {
    const io = getIO();
    const channel = typeof (event.data as any)?.channel === "string" ? (event.data as any).channel : null;
    if (channel) {
      io.to(channel).emit(event.event, event.data);
      return;
    }
    // ONE line per distinct event name per process, not one per event: voice
    // transcripts alone would make this unreadable within a single call. The
    // point is the enumeration - which events still broadcast tenant-wide - and
    // that is a set, not a stream. Deciding to make targets mandatory needs
    // that list first; failing hard without it would break events nobody has
    // identified yet, which is the silent breakage this change exists to avoid.
    if (!untargeted.has(event.event)) {
      untargeted.add(event.event);
      console.log(`[socket-bridge] untargeted event broadcasts tenant-wide: ${event.event}`);
    }
    io.to(`tenant:${event.tenantId}`).emit(event.event, event.data);
  } catch {
    // Socket not ready yet - event is dropped (acceptable per MVP spec)
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
// frontend also closes optimistically on the hangup button - both paths are
// idempotent because close() is a no-op when status === "CLOSED".
subscribeToEvents((event) => {
  handleVoiceSessionEnded(event).catch((err) => {
    console.warn("[voice-auto-close] handler threw:", (err as { message?: string })?.message ?? err);
  });
});

// Serve uploaded media files
const uploadsDir = process.env.UPLOADS_DIR || path.resolve(process.cwd(), "uploads");

// Same boot probe the incoming worker runs, for the same reason. This service
// is the one that SERVES attachments and also the one that stores an agent's
// own uploads, so a root-owned volume breaks it in both directions - and did,
// silently, until it was found by hand. See packages/shared/src/lib/media-storage.ts.
const uploadsProbe = probeUploadsDir(uploadsDir);
if (!uploadsProbe.ok) {
  console.error(describeUploadsProbe(uploadsProbe, "conversation"));
  reportOperationalFailure({
    errorCode: ERROR_CODES.media_storage_unwritable,
    domain: "media",
    service: "conversation",
    context: { dir: uploadsProbe.dir, reason: uploadsProbe.reason ?? "unknown" },
  });
} else {
  console.log(describeUploadsProbe(uploadsProbe, "conversation"));
}

app.use("/api/uploads", express.static(uploadsDir));

// Routes
app.use("/api/conversations", conversationRoutes);
app.use("/api/conversations", messageRoutes);
app.use("/api/templates", templateRoutes);
app.use("/api/broadcasts", broadcastRoutes);
app.use("/api/scheduled-messages", scheduledMessageRoutes);
app.use("/api/contacts", contactRoutes);
app.use("/api/gdpr/contacts", gdprContactsRoutes);
app.use("/api/identity", identityRoutes);
app.use("/api/approvals", approvalRoutes);
app.use("/api/audiences", audienceRoutes);
app.use("/api/tenant-settings", tenantSettingsRoutes);
app.use("/api/business-policies", businessPolicyRoutes);
app.use("/api/policy-decisions", policyDecisionRoutes);
app.use("/api/voice-sessions", voiceSessionsRoutes);
app.use("/api/voice-channels", voiceChannelsRoutes);
app.use("/api/auto-buy", autoBuyRoutes);

// NOTE: Outgoing message worker has been extracted to @chatcenter/outgoing-worker service
// for independent scaling. This service is now API + WebSocket only.

httpServer.listen(config.port, () => {
  console.log(`[${config.name}] running on port ${config.port} (build ${process.env.BUILD_SHA || "dev"})`);
});

export { app, httpServer };
