import { startIncomingWorker } from "./workers/incoming.worker";

console.log("[incoming-worker] Starting standalone incoming message worker...");

startIncomingWorker();

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("[incoming-worker] SIGTERM received, shutting down...");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("[incoming-worker] SIGINT received, shutting down...");
  process.exit(0);
});
