/**
 * StreamRouter - per-session fan-out of audio + transcripts into independent
 * downstream branches. One instance per voice session.
 *
 * Two branches, two failure domains:
 *   AUDIO     pushAudio(pcm, speaker)  → DeepgramSTTProvider.push (sync enqueue)
 *   TRANSCRIPT pushTranscript(event)   → [ProjectionSink, PersistenceSink]
 *                                          fire-and-forget, no shared await
 *
 * Guarantees (see architecture doc):
 *   - Router is stateless per message (no per-call accumulator).
 *   - No shared await between branches - slow Postgres does NOT stall Pub/Sub.
 *   - Ordering per callSid preserved by single-threaded event loop + seq on event.
 *   - Partials: may be lost (Pub/Sub fire-forget). Finals: must not be lost
 *     (PersistenceSink retries via idempotency key on next final; manual recovery
 *     via logs if Postgres is down across many finals).
 */
import type { Speaker } from "../stt/provider";
import type { Logger } from "../lib/logger";
import type { SttStream } from "../stt/provider";
import { publishEvent, prisma as sharedPrisma } from "@chatcenter/shared";

// The shared Prisma client is extended with tenant-guard middleware - use
// its actual inferred type (not the raw `PrismaClient` from @prisma/client)
// so method chains don't fail type-check.
type SharedPrisma = typeof sharedPrisma;

export interface TranscriptEvent {
  tenantId: string;
  conversationId: string;
  callSid: string;
  speaker: Speaker;
  text: string;
  isFinal: boolean;
  seq: number;
  ts: number;
  confidence?: number;
}

export interface StreamRouter {
  pushAudio(pcm: Int16Array, speaker: Speaker): void;
  pushTranscript(event: TranscriptEvent): void;
  close(): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────
// Sinks
// ─────────────────────────────────────────────────────────────────────────

/**
 * Fire-and-forget projection to Redis Pub/Sub. Every transcript goes through
 * here (partial + final). Conversation service subscribes and forwards to
 * Socket.IO. Failures are logged but never surface to the caller.
 */
function projectionDeliver(event: TranscriptEvent, logger: Logger): void {
  publishEvent({
    event: "voice.transcript",
    tenantId: event.tenantId,
    data: event,
  }).catch((err) => {
    logger.error({ err, conversationId: event.conversationId }, "projection: publish failed");
  });
}

/**
 * Durable persistence of final transcripts. Writes directly to Postgres via
 * Prisma. Idempotency relies on a unique index on
 * Message(conversationId, metadata->>'seq') for VOICE channel - Prisma emits
 * P2002 on conflict, which we swallow.
 *
 * Always called as fire-forget from the router; the caller does NOT await.
 */
function persistenceDeliver(
  event: TranscriptEvent,
  prisma: SharedPrisma,
  logger: Logger,
): void {
  if (!event.isFinal) return;
  // Stable per-utterance key - keeps duplicate inserts identifiable if any
  // slip past the in-memory reorder/dedup guards (e.g., after STT reconnect).
  const externalMessageId = `voice:${event.callSid}:${event.speaker}:${event.seq}`;
  prisma.message
    .create({
      data: {
        tenantId: event.tenantId,
        conversationId: event.conversationId,
        channel: "VOICE",
        externalMessageId,
        direction: event.speaker === "agent" ? "OUTBOUND" : "INBOUND",
        body: event.text,
        messageType: "text",
        status: "DELIVERED",
        senderName: event.speaker === "agent" ? "Agent" : "Customer",
        metadata: {
          seq: event.seq,
          callSid: event.callSid,
          speaker: event.speaker,
          role: event.speaker === "agent" ? "assistant" : "user",
          confidence: event.confidence ?? null,
        },
        deliveredAt: new Date(event.ts),
      },
    })
    .then((message) => {
      // Best-effort: bump lastMessageAt and notify the inbox UI. Neither is
      // load-bearing - if they fail, the message itself is safely in Postgres.
      prisma.conversation
        .update({
          where: { id: event.conversationId },
          data: { lastMessageAt: new Date(event.ts) },
        })
        .catch(() => { /* ignore */ });
      publishEvent({
        event: "message:new",
        tenantId: event.tenantId,
        data: { conversationId: event.conversationId, message },
      }).catch(() => { /* ignore */ });
    })
    .catch((err: unknown) => {
      const code = (err as { code?: string } | undefined)?.code;
      if (code === "P2002") return; // unique conflict = duplicate = expected
      logger.error(
        { err, conversationId: event.conversationId, seq: event.seq, callSid: event.callSid, text: event.text },
        "voice_persist_failed",
      );
    });
}

// ─────────────────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────────────────

export interface StreamRouterDeps {
  sttStream: SttStream;
  prisma: SharedPrisma;
  logger: Logger;
}

export function createStreamRouter(deps: StreamRouterDeps): StreamRouter {
  const { sttStream, prisma, logger } = deps;
  let closed = false;

  return {
    pushAudio(pcm: Int16Array, speaker: Speaker): void {
      if (closed) return;
      // Sync enqueue. DeepgramSTTProvider handles pre-open buffer + direct send.
      sttStream.push(pcm, speaker);
    },

    pushTranscript(event: TranscriptEvent): void {
      if (closed) return;
      // Both sinks are fire-and-forget. No awaits here.
      projectionDeliver(event, logger);
      persistenceDeliver(event, prisma, logger);
    },

    async close(): Promise<void> {
      closed = true;
      try { await sttStream.close(); } catch { /* ignore */ }
    },
  };
}
