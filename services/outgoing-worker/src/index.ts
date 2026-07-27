import { startOutgoingWorker } from "./workers/outgoing.worker";
import { startScheduledMessageWorker } from "./workers/scheduled.worker";
import { startBroadcastWorker } from "./workers/broadcast.worker";

import { assertEnforcementConfigured } from "@chatcenter/shared";

// Refuse to start on a configuration that fails open. Workers process billable
// work without a request in sight, so a worker running unenforced is not a
// smaller version of the problem - it is the least visible version of it.
assertEnforcementConfigured();

console.log("[outgoing-worker] Starting standalone outgoing message worker...");

startOutgoingWorker();
startScheduledMessageWorker();
startBroadcastWorker();

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("[outgoing-worker] SIGTERM received, shutting down...");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("[outgoing-worker] SIGINT received, shutting down...");
  process.exit(0);
});
