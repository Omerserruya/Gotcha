/* eslint-disable */
/**
 * Call-pilot smoke test.
 *
 * Drives the LiveAnalysisRunner via the shared Redis event bus:
 *   1. Publishes voice.session.started → supervisor spawns runner
 *   2. Publishes a sequence of voice.transcript events (mixed
 *      partial/final, customer/agent) — cadence fires on customer-final
 *      after ~1500ms debounce
 *   3. Waits ~10s for the LLM call + persistence
 *   4. Publishes voice.session.ended → supervisor tears down the runner
 *
 * Run from inside the `ai` container (or any container on the docker
 * network with @chatcenter/shared installed):
 *   docker compose exec -T ai node /app/callpilot-smoke.js
 *
 * Verification (after the script exits):
 *   SELECT * FROM call_analyses WHERE call_sid = '<printed callSid>';
 *   SELECT * FROM usage_logs WHERE created_at > NOW() - INTERVAL '1 minute'
 *     AND feature = 'live_call_intelligence';
 */
const { randomUUID } = require("crypto");
const Redis = require("ioredis");

const REDIS_URL = process.env.REDIS_URL || "redis://redis:6379";
const CHANNEL = "chatcenter:events";
const TENANT_ID = process.env.TENANT_ID || "cmmov5qh10000ltnqm7pmxqzc";
const CONVERSATION_ID = process.argv[2] || "cmpima52i000nrn8diyi791lj";

const callSid = `smoke-${randomUUID().slice(0, 8)}`;
const startMs = Date.now();
let seq = 0;

const pub = new Redis(REDIS_URL, { maxRetriesPerRequest: null });

async function publish(event, data) {
  await pub.publish(CHANNEL, JSON.stringify({ event, tenantId: TENANT_ID, data }));
}

function utterance(speaker, text, isFinal = true) {
  seq += 1;
  return {
    callSid,
    speaker,
    text,
    isFinal,
    seq,
    startMs: Date.now() - startMs,
    confidence: 0.95,
  };
}

async function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

(async () => {
  console.log(JSON.stringify({ phase: "open", callSid, conversationId: CONVERSATION_ID }));
  await publish("voice.session.started", {
    callSid,
    conversationId: CONVERSATION_ID,
    agentId: null,
  });

  // Give the supervisor a moment to spawn the runner + subscribe.
  await wait(800);

  console.log(JSON.stringify({ phase: "transcript-1" }));
  await publish("voice.transcript", utterance("customer", "Hi, I'm Sarah from Acme Logistics."));
  await wait(400);
  await publish("voice.transcript", utterance("agent", "Hi Sarah, how can I help you today?"));
  await wait(1700);

  console.log(JSON.stringify({ phase: "transcript-2" }));
  await publish(
    "voice.transcript",
    utterance(
      "customer",
      "We have twenty-five sales reps and we're evaluating WhatsApp business platforms. What pricing tiers do you offer?",
    ),
  );
  await wait(1800);

  console.log(JSON.stringify({ phase: "transcript-3" }));
  await publish(
    "voice.transcript",
    utterance(
      "customer",
      "And I need to know about CRM integration — we use HubSpot.",
    ),
  );
  await wait(1800);

  console.log(JSON.stringify({ phase: "wait-for-runner-output" }));
  // Runner is async; the cadence fires the LLM, then writes a frame.
  // gpt-4o-mini at this prompt size finishes in 2–4s.
  await wait(8000);

  console.log(JSON.stringify({ phase: "close", callSid }));
  await publish("voice.session.ended", { callSid });

  await wait(300);
  await pub.quit();
  console.log(JSON.stringify({ done: true, callSid }));
})().catch((err) => {
  console.error("smoke failed:", err && err.message ? err.message : err);
  process.exit(1);
});
