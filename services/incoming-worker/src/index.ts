import { startIncomingWorker } from "./workers/incoming.worker";
import { startChannelHealthWorker } from "./workers/channel-health.worker";

console.log("[incoming-worker] Starting standalone incoming message worker...");

startIncomingWorker();
startChannelHealthWorker().catch((err) => {
  console.error("[incoming-worker] Failed to start channel health worker:", err);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("[incoming-worker] SIGTERM received, shutting down...");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("[incoming-worker] SIGINT received, shutting down...");
  process.exit(0);
});
