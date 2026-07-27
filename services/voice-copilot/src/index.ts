import { createApp } from "./app";
import { loadEnv } from "./config/env";
import { logger } from "./lib/logger";
import { assertEnforcementConfigured } from "@chatcenter/shared";

async function main(): Promise<void> {
  // Before anything else: a voice call is billable work, and a stack that
  // cannot say who is allowed to make one should not answer the phone.
  assertEnforcementConfigured();
  const env = loadEnv();
  const { httpServer, shutdown } = createApp();

  const port = env.PORT;

  httpServer.listen(port, () => {
    logger.info({ port, service: "voice-copilot" }, "voice-copilot listening");
  });

  process.on("SIGTERM", async () => {
    logger.info("SIGTERM received - draining");
    await shutdown();
    logger.info("voice-copilot stopped");
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    logger.info("SIGINT received - stopping");
    await shutdown();
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error({ err }, "voice-copilot failed to start");
  process.exit(1);
});
