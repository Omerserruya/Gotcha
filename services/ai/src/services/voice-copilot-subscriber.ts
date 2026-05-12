/**
 * voice-copilot-subscriber.ts
 *
 * Listens to the shared Redis pub/sub bus for `voice.transcript` events
 * published by voice-copilot and fires the copilot suggestions pipeline
 * after every customer-final utterance.
 *
 * Contract:
 *   Event: `voice.transcript` (tenantId, { speaker, isFinal, conversationId, ... })
 *   Trigger: speaker === "customer" && isFinal === true
 *   Behavior: scheduleAssistTrigger() — debounced 1500 ms, dedupes rapid finals.
 *
 * Architecture rationale: we already own the final-utterance stream via the
 * voice-copilot → pub/sub projection; re-reading it here avoids an HTTP
 * round-trip from voice-copilot → /api/ai-assist/voice and keeps the
 * persistence path (voice-copilot → Postgres) as the single writer.
 */
import type Redis from "ioredis";
import { subscribeToEvents } from "@chatcenter/shared";
import { scheduleAssistTrigger } from "./voice-assist.service";

let sub: Redis | null = null;

export function startVoiceCopilotSubscriber(): void {
  if (sub) return;
  sub = subscribeToEvents((event) => {
    if (event.event !== "voice.transcript") return;
    const data = event.data as {
      speaker?: string;
      isFinal?: boolean;
      conversationId?: string;
    } | undefined;
    if (!data?.isFinal || data.speaker !== "customer" || !data.conversationId) return;

    // Fire-and-forget; scheduleAssistTrigger handles its own errors.
    scheduleAssistTrigger(event.tenantId, data.conversationId).catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[voice-copilot-subscriber] scheduleAssistTrigger rejected:", err);
    });
  });
  // eslint-disable-next-line no-console
  console.log("[voice-copilot-subscriber] listening for voice.transcript customer finals");
}

export async function stopVoiceCopilotSubscriber(): Promise<void> {
  if (!sub) return;
  try { await sub.quit(); } catch { /* ignore */ }
  sub = null;
}
