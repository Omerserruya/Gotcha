import { subscribeToEvents, type ServiceEvent } from "@chatcenter/shared";
import { LiveStreamingSource } from "./sources";
import { LiveAnalysisRunner } from "./live-analysis-runner";
import { loadCopilotConfigForConversation } from "./copilot-config-loader";

/**
 * Maps bus lifecycle events to LiveAnalysisRunner lifecycle.
 *
 * Runs ALONGSIDE the existing voice-copilot-subscriber for the duration of
 * Phase 3. Both consume `voice.transcript`; the legacy subscriber drives
 * the chat-shaped suggestion path; this supervisor drives the structured
 * Conversation Intelligence Engine path. Phase 4 retires the legacy
 * subscriber and this supervisor remains as the only live consumer.
 *
 * Lifecycle:
 *   voice.session.started   → create LiveStreamingSource + runner, start
 *   voice.session.ended     → stop the runner for that callSid
 *   voice.transcript        → handled internally by the source's bus
 *                             subscription (the supervisor doesn't need
 *                             to forward; the source self-subscribes)
 *
 * Idempotent: if a session.started arrives twice for the same callSid the
 * second is ignored. If a session.ended arrives for an unknown callSid
 * we silently no-op.
 *
 * Failure mode: if the runner fails to start, the existing live path keeps
 * working — both paths run independently and one can fail without taking
 * down the other.
 */

interface ActiveRunner {
  runner: LiveAnalysisRunner;
  source: LiveStreamingSource;
}

const runners = new Map<string, ActiveRunner>();
let started = false;

export function startLiveRunnerSupervisor(): void {
  if (started) return;
  started = true;

  try {
    subscribeToEvents((evt: ServiceEvent) => {
      try {
        if (evt.event === "voice.session.started") {
          handleStarted(evt).catch((err: any) => {
            console.warn(
              "[intelligence.supervisor] handleStarted failed:",
              err?.message,
            );
          });
        } else if (evt.event === "voice.session.ended") {
          handleEnded(evt);
        }
      } catch (err: any) {
        console.warn(
          "[intelligence.supervisor] handler failed:",
          err?.message,
        );
      }
    });
    console.log(
      "[intelligence] live-runner supervisor started (subscribed to voice.session.*)",
    );
  } catch (err: any) {
    console.warn(
      "[intelligence.supervisor] subscribe failed:",
      err?.message,
    );
  }
}

async function handleStarted(evt: ServiceEvent): Promise<void> {
  const data: any = evt.data ?? {};
  const callSid = String(data.callSid ?? "");
  const conversationId = String(data.conversationId ?? "");
  const tenantId = evt.tenantId;
  const agentId = data.agentId ? String(data.agentId) : undefined;
  if (!callSid || !conversationId || !tenantId) {
    console.warn("[intelligence.supervisor] session.started missing fields", {
      hasCallSid: !!callSid,
      hasConv: !!conversationId,
      hasTenant: !!tenantId,
    });
    return;
  }
  if (runners.has(callSid)) return;
  console.log(
    `[intelligence.supervisor] spinning up live runner for callSid=${callSid} conv=${conversationId}`,
  );

  // Resolve the per-channel copilot config exactly once at spawn time so
  // every turn shares the same language/goals/data-fields configuration.
  // Falls through to EMPTY_COPILOT_CONFIG on lookup failure — never blocks.
  const copilotConfig = await loadCopilotConfigForConversation(conversationId);

  // A late session.started retry can race the lookup — re-check to keep
  // the singleton-per-callSid invariant after the await.
  if (runners.has(callSid)) return;

  const source = new LiveStreamingSource(conversationId, callSid);
  const runner = new LiveAnalysisRunner(source, {
    tenantId,
    conversationId,
    callSid,
    agentId,
    copilotConfig,
  });

  runners.set(callSid, { runner, source });

  runner.start().catch((err: any) => {
    console.warn(
      "[intelligence.supervisor] runner.start failed:",
      err?.message,
    );
    runners.delete(callSid);
  });
}

function handleEnded(evt: ServiceEvent): void {
  const data: any = evt.data ?? {};
  const callSid = String(data.callSid ?? "");
  if (!callSid) return;
  const active = runners.get(callSid);
  if (!active) return;
  runners.delete(callSid);
  active.runner.stop("session_ended").catch((err: any) => {
    console.warn(
      "[intelligence.supervisor] runner.stop failed:",
      err?.message,
    );
  });
}

/** Test seam — list active runner callSids. */
export function __activeRunnerCallSidsForTests(): string[] {
  return [...runners.keys()];
}
