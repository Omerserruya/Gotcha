import { prisma, subscribeToEvents, type ServiceEvent } from "@chatcenter/shared";
import {
  getVoicePostCallQueue,
  VOICE_POSTCALL_JOB_NAME,
  DEFAULT_VOICE_POSTCALL_JOB_OPTS,
  type VoicePostCallJobData,
} from "./queue";

/**
 * Listens on the shared event bus for end-of-call signals and seeds the
 * post-call pipeline.
 *
 * Triggers:
 *   - `voice.session.ended` (StreamRouter / Reaper) — always fires
 *   - `voice.session.state` / `voice.session.state_changed` with state in
 *     {ENDED, FAILED} — defense in depth; we ignore duplicates via
 *     idempotent upsert + jobId-keyed enqueue.
 *
 * Each trigger upserts a `VoiceCallPostProcessing` row (stage=PENDING) and
 * enqueues an advance job keyed by sessionId.
 */

let _sub: ReturnType<typeof subscribeToEvents> | null = null;
let _started = false;

interface SessionLookup {
  callSid?: string | null;
  sessionId?: string | null;
  conversationId?: string | null;
  state?: string | null;
}

function isTerminalState(state?: string | null): boolean {
  if (!state) return false;
  const upper = String(state).toUpperCase();
  return upper === "ENDED" || upper === "FAILED";
}

async function resolveSessionId(data: SessionLookup): Promise<string | null> {
  if (data.sessionId) return String(data.sessionId);
  if (data.callSid) {
    try {
      const s = await prisma.voiceCallSession.findUnique({
        where: { callSid: String(data.callSid) },
        select: { id: true },
      });
      if (s) return s.id;
    } catch {
      /* ignore */
    }
  }
  if (data.conversationId) {
    try {
      const s = await prisma.voiceCallSession.findUnique({
        where: { conversationId: String(data.conversationId) },
        select: { id: true },
      });
      if (s) return s.id;
    } catch {
      /* ignore */
    }
  }
  return null;
}

async function enqueueAdvance(sessionId: string): Promise<void> {
  // Multiple end-of-call events fire concurrently for the same session
  // (`voice.session.ended` plus `voice.session.state*`). The earlier
  // implementation used `upsert` and swallowed the P2002 from the losing
  // race, but Prisma's engine still logs `prisma:error` before our catch
  // sees the failure — every call produced 3 noisy stack traces.
  //
  // `createMany({ skipDuplicates: true })` translates to
  // `INSERT ... ON CONFLICT DO NOTHING` so the conflict never escalates
  // to an error event. Same idempotency, zero log noise. We never need
  // to update an existing row here — the workers themselves bump `stage`
  // / `attempts` later.
  try {
    await prisma.voiceCallPostProcessing.createMany({
      data: [{
        sessionId,
        stage: "PENDING",
        attempts: 0,
        startedAt: new Date(),
      }],
      skipDuplicates: true,
    });
  } catch (err) {
    console.warn(
      "[voice-postcall.subscriber] createMany postprocessing row failed:",
      (err as { message?: string })?.message,
    );
    return;
  }
  try {
    await getVoicePostCallQueue().add(
      VOICE_POSTCALL_JOB_NAME,
      { sessionId } as VoicePostCallJobData,
      // BullMQ rejects `:` in custom job ids (Redis key separator).
      { ...DEFAULT_VOICE_POSTCALL_JOB_OPTS, jobId: `voice-postcall-${sessionId}` },
    );
  } catch (err) {
    console.warn(
      "[voice-postcall.subscriber] enqueue failed:",
      (err as { message?: string })?.message,
    );
  }
}

export function startVoicePostCallSubscriber(): void {
  if (_started) return;
  _started = true;
  try {
    _sub = subscribeToEvents((evt: ServiceEvent) => {
      try {
        const eventName = evt.event;
        const data = (evt.data ?? {}) as SessionLookup;
        let shouldTrigger = false;
        if (eventName === "voice.session.ended") {
          shouldTrigger = true;
        } else if (
          (eventName === "voice.session.state" || eventName === "voice.session.state_changed") &&
          isTerminalState(data.state ?? (data as Record<string, unknown>).to as string)
        ) {
          shouldTrigger = true;
        }
        if (!shouldTrigger) return;
        resolveSessionId(data)
          .then((sessionId) => {
            if (!sessionId) return;
            return enqueueAdvance(sessionId);
          })
          .catch((err) => {
            console.warn(
              "[voice-postcall.subscriber] handler error:",
              err?.message ?? err,
            );
          });
      } catch (err) {
        console.warn(
          "[voice-postcall.subscriber] handler threw:",
          (err as { message?: string })?.message,
        );
      }
    });
    console.log(
      "[voice-postcall] subscriber started (voice.session.ended | voice.session.state*)",
    );
  } catch (err) {
    console.warn(
      "[voice-postcall.subscriber] subscribe failed:",
      (err as { message?: string })?.message,
    );
  }
}

export async function stopVoicePostCallSubscriber(): Promise<void> {
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
