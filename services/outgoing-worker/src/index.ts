import { startOutgoingWorker } from "./workers/outgoing.worker";

console.log("[outgoing-worker] Starting standalone outgoing message worker...");

startOutgoingWorker();

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("[outgoing-worker] SIGTERM received, shutting down...");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("[outgoing-worker] SIGINT received, shutting down...");
  process.exit(0);
});
