/* eslint-disable */
/**
 * Smoke-test injection harness - pushes a single normalized inbound
 * WhatsApp message into the BullMQ "incoming-messages" queue, exactly as
 * the webhook would after Twilio/Meta delivery.
 *
 * Usage (inside the running ai/incoming-worker container or any node with
 * @chatcenter/shared installed):
 *
 *   node scripts/smoke-test-inject.js "Hi, my name is Omer Serruya" \
 *        --senderId 972525401686 --senderName "Omer Serruya"
 *
 * The script reads tenantId + channelAccountId from CLI flags or env.
 * It does NOT bypass any worker logic - the message is processed by the
 * real incoming.worker exactly as a webhook-delivered message.
 */
const { Queue } = require("bullmq");
const { randomUUID } = require("crypto");

const REDIS_URL = process.env.REDIS_URL || "redis://redis:6379";
const TENANT_ID = process.env.TENANT_ID || "cmmov5qh10000ltnqm7pmxqzc";
const CHANNEL_ACCOUNT_ID =
  process.env.CHANNEL_ACCOUNT_ID || "cmnbjiz4a00011uwy9lvhgv3c";

const args = process.argv.slice(2);
const body = args[0];
if (!body) {
  console.error('Usage: node smoke-test-inject.js "<message body>" [--senderId N] [--senderName "Name"]');
  process.exit(2);
}

function flag(name, def) {
  const i = args.indexOf("--" + name);
  return i >= 0 ? args[i + 1] : def;
}

const senderId = flag("senderId", "972525401686");
const senderDisplayName = flag("senderName", "Omer Serruya");
const externalMessageId = flag("msgId", `wamid.${randomUUID()}`);

(async () => {
  const q = new Queue("incoming-messages", { connection: { url: REDIS_URL } });
  try {
    const job = await q.add(
      "process",
      {
        tenantId: TENANT_ID,
        channel: "WHATSAPP",
        channelAccountId: CHANNEL_ACCOUNT_ID,
        normalizedMessage: {
          externalMessageId,
          senderId,
          senderDisplayName,
          timestamp: new Date().toISOString(),
          contentType: "text",
          body,
          messageType: "text",
        },
      },
      { attempts: 3, backoff: { type: "exponential", delay: 1000 } },
    );
    console.log(JSON.stringify({
      enqueued: true,
      jobId: job.id,
      externalMessageId,
      senderId,
      tenantId: TENANT_ID,
      body,
    }));
  } finally {
    await q.close();
  }
})().catch((err) => {
  console.error("inject failed:", err && err.message ? err.message : err);
  process.exit(1);
});
