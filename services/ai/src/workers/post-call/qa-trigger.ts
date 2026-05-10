import { subscribeToEvents, type ServiceEvent } from "@chatcenter/shared";
import {
  getPostCallQAQueue,
  DEFAULT_POST_CALL_JOB_OPTS,
} from "../../services/intelligence/queues";

/**
 * Fires a Mode A QA job whenever a voice session ends.
 *
 * Subscribes to `voice.session.ended` (published by services/voice-copilot
 * StreamRouter on session teardown). Any other lifecycle event ignored.
 *
 * Idempotent at the queue layer via `jobId = qa:{conversationId}` — if the
 * session.ended event somehow fires twice for the same call (rare but
 * possible during voice-copilot reconnect storms), the second add is a
 * no-op rather than producing a duplicate score.
 */

let _started = false;
let _sub: ReturnType<typeof subscribeToEvents> | null = null;

export function startPostCallQATrigger(): void {
  if (_started) return;
  _started = true;
  try {
    _sub = subscribeToEvents((evt: ServiceEvent) => {
      try {
        if (evt.event !== "voice.session.ended") return;
        const data: any = evt.data ?? {};
        const conversationId = String(data.conversationId ?? "");
        const callSid = data.callSid ? String(data.callSid) : undefined;
        if (!conversationId || !evt.tenantId) return;
        getPostCallQAQueue()
          .add(
            "qa",
            { conversationId, tenantId: evt.tenantId, callSid },
            { ...DEFAULT_POST_CALL_JOB_OPTS, jobId: `qa-${conversationId}` },
          )
          .catch((err: any) => {
            console.warn(
              "[post-call.qa.trigger] enqueue failed:",
              err?.message,
            );
          });
      } catch (err: any) {
        console.warn("[post-call.qa.trigger] handler failed:", err?.message);
      }
    });
    console.log(
      "[post-call] qa trigger started (subscribed to voice.session.ended)",
    );
  } catch (err: any) {
    console.warn("[post-call.qa.trigger] subscribe failed:", err?.message);
  }
}

export async function stopPostCallQATrigger(): Promise<void> {
  if (_sub) {
    try {
      await _sub.quit();
    } catch {
      /* ignore */
    }
    _sub = null;
  }
  _started = false;
}
