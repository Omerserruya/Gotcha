import { initSentry } from "@chatcenter/shared";

// First statement in the process. These workers have no HTTP layer and so no
// shared factory to hang this off - the trade-off of not booting through
// createServiceApp is that this one line has to be remembered here.
// Production-only; a no-op everywhere else.
initSentry("incoming-worker");

import { startIncomingWorker } from "./workers/incoming.worker";
import { startChannelHealthWorker } from "./workers/channel-health.worker";
import { startIdleConversationWorker } from "./workers/idle-conversation.worker";
import { startFlowResumeWorker } from "./workers/flow-resume.worker";

import { assertEnforcementConfigured } from "@chatcenter/shared";

// Refuse to start on a configuration that fails open. Workers process billable
// work without a request in sight, so a worker running unenforced is not a
// smaller version of the problem - it is the least visible version of it.
assertEnforcementConfigured();

console.log("[incoming-worker] Starting standalone incoming message worker...");

startIncomingWorker();
startChannelHealthWorker().catch((err) => {
  console.error("[incoming-worker] Failed to start channel health worker:", err);
});
startIdleConversationWorker().catch((err) => {
  console.error("[incoming-worker] Failed to start idle conversation worker:", err);
});
// Flow resume - drains delayed-resume jobs enqueued by Wait nodes in the
// graph walker, re-entering the flow at the scheduled node.
startFlowResumeWorker();
console.log("[flow-resume] Worker started");

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("[incoming-worker] SIGTERM received, shutting down...");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("[incoming-worker] SIGINT received, shutting down...");
  process.exit(0);
});
