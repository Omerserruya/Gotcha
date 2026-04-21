import { BoundedAudioQueue } from "../audio/queue";
import { ReorderBuffer } from "../transcript/reorder-buffer";
import { mulawDecode } from "../audio/mulaw";
import { InvalidStateTransition } from "../lib/errors";
import type { SessionRecord, SessionState, SessionStore } from "./session-store";
import type { STTProvider, SttConfig, SttStream, SttError, Transcript, Speaker } from "../stt/provider";
import type { Clock } from "../lib/clock";
import type { Logger } from "../lib/logger";
import type { Metrics } from "../metrics/metrics";
import type { ServiceEvent } from "@chatcenter/shared";
import { prisma } from "@chatcenter/shared";
import type { Dispatcher } from "../dispatch/dispatcher";
import { createStreamRouter, type StreamRouter } from "../router/stream-router";

export type { SessionRecord, SessionState } from "./session-store";

export const SESSION_TRANSITIONS: Readonly<Record<SessionState, readonly SessionState[]>> = Object.freeze({
  ringing: Object.freeze(["active", "ended"] as const),
  active: Object.freeze(["ended"] as const),
  ended: Object.freeze([] as const),
});

export type EndReason =
  | "stop"
  | "ws_closed"
  | "reaper"
  | "stt_overload"
  | "shutdown"
  | "panic"
  | "redis_outage";

export interface SessionDeps {
  record: SessionRecord;
  store: SessionStore;
  sttFactory: (cfg: SttConfig) => STTProvider;
  sttConfig: SttConfig;
  dispatcher: Dispatcher;
  clock: Clock;
  logger: Logger;
  metrics: Metrics;
  eventBus: { publish(e: ServiceEvent): Promise<void> };
  reconnectGraceMs?: number;
  sessionTtlSeconds?: number;
}

// Parsed media frame shape (subset used by handleMediaFrame).
// Twilio sends `track` as bare "inbound"/"outbound" — not the historical
// `inbound_track`/`outbound_track` form. Accept both literal forms.
export interface MediaFrameParsed {
  sequenceNumber: string;
  media: {
    track: string;
    payload: string; // base64 mulaw
    timestamp: string;
  };
}

function isInboundTrack(track: string): boolean {
  return track === "inbound" || track === "inbound_track";
}

const QUEUE_CAPACITY = 200;
const REFRESH_TTL_INTERVAL_MS = 30_000;
const STT_ERROR_WINDOW_MS = 30_000;
const STT_RATE_LIMIT_PAUSE_MS = 2_000;
const STT_OVERLOAD_THRESHOLD = 3;
const SESSION_DELETE_GRACE_MS = 10_000;
const DEFAULT_SESSION_TTL_SECONDS = 900;

export class Session {
  readonly tenantId: string;
  readonly conversationId: string;
  readonly callSid: string;
  readonly startedAt: number;

  private _state: SessionState;
  private _sttStream?: SttStream;
  private _router?: StreamRouter;
  private _endCalled = false;
  private _loggedTrackSkip = false;

  private readonly audioQueues = {
    agent: new BoundedAudioQueue(QUEUE_CAPACITY, () => this.onDrop("agent")),
    customer: new BoundedAudioQueue(QUEUE_CAPACITY, () => this.onDrop("customer")),
  };

  private readonly reorder = {
    agent: new ReorderBuffer("agent"),
    customer: new ReorderBuffer("customer"),
  };

  private readonly sttErrorWindow: number[] = []; // timestamps of RATE_LIMIT errors
  private sttPaused = false;

  private readonly highWater: Record<Speaker, number> = { agent: -1, customer: -1 };

  // Timers
  private reconnectGraceTimer: { cancel(): void } | null = null;
  private refreshTtlTimer: { cancel(): void } | null = null;

  constructor(private readonly deps: SessionDeps) {
    this.tenantId = deps.record.tenantId;
    this.conversationId = deps.record.conversationId;
    this.callSid = deps.record.callSid;
    this.startedAt = deps.record.startedAt;
    this._state = deps.record.state;
  }

  get state(): SessionState {
    return this._state;
  }

  // ---------------------------------------------------------------------------
  // bootstrap — persist record, publish started event
  // ---------------------------------------------------------------------------
  async bootstrap(): Promise<void> {
    const ttl = this.deps.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
    await this.safe(async () => {
      await this.deps.store.create(this.deps.record, ttl);
      await this.deps.store.setCallSidIndex(
        this.tenantId,
        this.callSid,
        this.conversationId,
        ttl
      );
      await this.deps.eventBus.publish({
        event: "voice.session.started",
        tenantId: this.tenantId,
        data: {
          conversationId: this.conversationId,
          callSid: this.callSid,
          agentId: this.deps.record.agentId,
          ts: this.deps.clock.now(),
        },
      });
      this.deps.metrics.sessionsStarted.inc({ tenant: this.tenantId });
      this.deps.metrics.sessionsActive.inc();
    });
  }

  // ---------------------------------------------------------------------------
  // handleMediaFrame
  // ---------------------------------------------------------------------------
  async handleMediaFrame(frame: MediaFrameParsed, fixedSpeaker?: Speaker): Promise<void> {
    await this.safe(async () => {
      if (this._state === "ended") {
        throw new InvalidStateTransition("ended", "active");
      }

      // ringing → active on first frame
      if (this._state === "ringing") {
        this.transitionTo("active");
        this.deps.logger.info({
          callSid: this.callSid,
          conversationId: this.conversationId,
          fixedSpeaker,
          firstFrameTrack: frame.media.track,
        }, "session: first media frame");
        // Start STT stream
        await this.ensureSttStream();
        // Start periodic TTL refresh
        this.startTtlRefresh();
      }

      // Attribution modes:
      //   (a) CONFERENCE (preferred): WS is attached per-participant — every
      //       frame represents ONE speaker. `fixedSpeaker` (from
      //       customParameters.speaker on the start frame) is authoritative;
      //       outbound_track frames carry mixed conference audio and are
      //       skipped to avoid echo-transcribing the other party.
      //   (b) LEGACY parent-leg <Start><Stream track=both_tracks>:
      //       inbound_track → customer, outbound_track → agent.
      let speaker: Speaker;
      if (fixedSpeaker) {
        if (!isInboundTrack(frame.media.track)) {
          if (!this._loggedTrackSkip) {
            this._loggedTrackSkip = true;
            this.deps.logger.info({ fixedSpeaker, track: frame.media.track, callSid: this.callSid }, "session: skipping non-inbound track (mixed audio)");
          }
          return;
        }
        speaker = fixedSpeaker;
      } else {
        speaker = isInboundTrack(frame.media.track) ? "customer" : "agent";
      }
      const seqFromTwilio = parseInt(frame.sequenceNumber, 10);
      const pcm = mulawDecode(Buffer.from(frame.media.payload, "base64"));

      this.audioQueues[speaker].enqueue({
        pcm,
        timestamp: this.deps.clock.now(),
        seqFromTwilio,
      });

      // Late-drop check: if seq < highWater - 10 → drop metric
      if (seqFromTwilio < this.highWater[speaker] - 10) {
        this.deps.metrics.framesLateDropped.inc({ tenant: this.tenantId });
      } else {
        this.highWater[speaker] = Math.max(this.highWater[speaker], seqFromTwilio);
      }

      this.deps.metrics.framesReceived.inc({ tenant: this.tenantId, speaker });

      // Push to STT (with backoff for rate-limit)
      this.safePushWithBackoff(pcm, speaker);
    });
  }

  // ---------------------------------------------------------------------------
  // handleStop — graceful stop signal from Twilio
  // ---------------------------------------------------------------------------
  async handleStop(): Promise<void> {
    await this.safe(async () => {
      await this.end("stop");
    });
  }

  // ---------------------------------------------------------------------------
  // handleWsClose — WS disconnected; start grace timer
  // ---------------------------------------------------------------------------
  async handleWsClose(): Promise<void> {
    if (this._state === "ended") return;
    const graceMs = this.deps.reconnectGraceMs ?? 10_000;
    this.reconnectGraceTimer = this.deps.clock.setTimeout(async () => {
      if (this._state !== "ended") {
        await this.safe(async () => {
          await this.end("ws_closed");
        });
      }
    }, graceMs);
  }

  // ---------------------------------------------------------------------------
  // resumeFromReconnect — cancel grace timer, increment reconnect counter
  // ---------------------------------------------------------------------------
  async resumeFromReconnect(): Promise<void> {
    await this.safe(async () => {
      if (this.reconnectGraceTimer) {
        this.reconnectGraceTimer.cancel();
        this.reconnectGraceTimer = null;
      }
      this.deps.metrics.reconnects.inc({ tenant: this.tenantId });
    });
  }

  // ---------------------------------------------------------------------------
  // end — terminate session cleanly
  // ---------------------------------------------------------------------------
  async end(reason: EndReason): Promise<void> {
    if (this._endCalled) return;
    this._endCalled = true;

    // Cancel timers
    this.reconnectGraceTimer?.cancel();
    this.reconnectGraceTimer = null;
    this.refreshTtlTimer?.cancel();
    this.refreshTtlTimer = null;

    // Transition state (skip if already ended — e.g., panic called twice)
    try {
      if (this._state !== "ended") {
        this.transitionTo("ended");
      }
    } catch {
      // Already ended
    }

    // Close STT stream
    try {
      await this._sttStream?.close();
    } catch (err) {
      this.deps.logger.error({ err }, "session: sttStream.close failed");
    }

    // Flush any buffered transcripts
    try {
      await this.deps.dispatcher.flushSession(this.tenantId, this.conversationId);
    } catch (err) {
      this.deps.logger.error({ err }, "session: dispatcher.flushSession failed");
    }

    // Update state in store
    try {
      await this.deps.store.updateState(this.tenantId, this.conversationId, "ended");
    } catch (err) {
      this.deps.logger.error({ err }, "session: store.updateState failed");
    }

    // Publish ended event
    try {
      await this.deps.eventBus.publish({
        event: "voice.session.ended",
        tenantId: this.tenantId,
        data: {
          conversationId: this.conversationId,
          callSid: this.callSid,
          reason,
          ts: this.deps.clock.now(),
        },
      });
    } catch (err) {
      this.deps.logger.error({ err }, "session: publishEvent failed");
    }

    // Delete session key after brief grace (keeps stats for /live)
    this.deps.clock.setTimeout(async () => {
      try {
        await this.deps.store.delete(this.tenantId, this.conversationId);
      } catch (err) {
        this.deps.logger.error({ err }, "session: store.delete failed");
      }
    }, SESSION_DELETE_GRACE_MS);

    this.deps.metrics.sessionsEnded.inc({ tenant: this.tenantId, reason });
    this.deps.metrics.sessionsActive.dec();

    if (reason === "panic") {
      this.deps.metrics.sessionPanic.inc();
    }
    if (reason === "stt_overload") {
      this.deps.metrics.voiceOverload.inc();
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private transitionTo(next: SessionState): void {
    const allowed = SESSION_TRANSITIONS[this._state];
    if (!(allowed as readonly string[]).includes(next)) {
      throw new InvalidStateTransition(this._state, next);
    }
    const prev = this._state;
    this._state = next;
    // Fire-and-forget — errors caught in safe()
    this.deps.eventBus.publish({
      event: "voice.session.state_changed",
      tenantId: this.tenantId,
      data: {
        conversationId: this.conversationId,
        from: prev,
        to: next,
        ts: this.deps.clock.now(),
      },
    }).catch((err) => {
      this.deps.logger.error({ err }, "session: state_changed publish failed");
    });
  }

  private async ensureSttStream(): Promise<void> {
    if (this._sttStream) return;
    const provider = this.deps.sttFactory(this.deps.sttConfig);
    const stream = await provider.start({
      tenantId: this.tenantId,
      conversationId: this.conversationId,
      callSid: this.callSid,
      language: this.deps.sttConfig.language,
      interimResults: this.deps.sttConfig.interimResults,
      apiKey: this.deps.sttConfig.apiKey,
      onError: (e: SttError) => this.onSttError(e),
    });

    stream.on("partial", (t: Transcript) => {
      try {
        this.onTranscript(t);
      } catch (err) {
        this.deps.logger.error({ err }, "session: onTranscript (partial) threw");
        void this.safe(async () => { await this.end("panic"); });
      }
    });

    stream.on("final", (t: Transcript) => {
      try {
        this.onTranscript(t);
      } catch (err) {
        this.deps.logger.error({ err }, "session: onTranscript (final) threw");
        void this.safe(async () => { await this.end("panic"); });
      }
    });

    stream.on("error", (e: SttError) => {
      try {
        this.onSttError(e);
      } catch (err) {
        this.deps.logger.error({ err }, "session: onSttError threw");
      }
    });

    this._sttStream = stream;
    // Build the StreamRouter once the STT stream exists. Router encapsulates
    // the audio branch (→ Deepgram) and the transcript branch (→ Pub/Sub +
    // Postgres). Fan-out is fire-and-forget; branches don't share an await.
    this._router = createStreamRouter({
      sttStream: stream,
      prisma,
      logger: this.deps.logger,
    });
  }

  private startTtlRefresh(): void {
    const ttl = this.deps.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
    this.refreshTtlTimer = this.deps.clock.setInterval(async () => {
      try {
        await this.deps.store.refreshTtl(this.tenantId, this.conversationId, ttl);
      } catch (err) {
        this.deps.logger.error({ err }, "session: refreshTtl failed");
      }
    }, REFRESH_TTL_INTERVAL_MS);
  }

  private onTranscript(t: Transcript): void {
    const buf = this.reorder[t.speaker];
    buf.ingest(t);
    const router = this._router;
    if (!router) return;
    for (const emit of buf.drain()) {
      // Single fan-out call — router handles projection (Pub/Sub) + persistence
      // (Postgres finals) in independent fire-and-forget branches. No awaits.
      router.pushTranscript({
        tenantId: this.tenantId,
        conversationId: this.conversationId,
        callSid: this.callSid,
        speaker: emit.speaker,
        text: emit.text,
        isFinal: emit.isFinal,
        seq: emit.seq,
        ts: emit.timestamp,
        confidence: emit.confidence,
      });
    }
  }

  private safePushWithBackoff(pcm: Int16Array, speaker: Speaker): void {
    if (this.sttPaused) {
      // Audio already in queue — it will be drained when resume
      return;
    }
    try {
      this._sttStream?.push(pcm, speaker);
    } catch (err) {
      this.deps.logger.error({ err }, "session: sttStream.push threw");
    }
  }

  private onSttError(e: SttError): void {
    this.deps.metrics.sttErrors.inc({ code: e.code });

    if (e.code === "RATE_LIMIT") {
      const now = this.deps.clock.now();
      this.sttErrorWindow.push(now);
      // Prune entries older than 30s
      const cutoff = now - STT_ERROR_WINDOW_MS;
      while (this.sttErrorWindow.length > 0 && this.sttErrorWindow[0] < cutoff) {
        this.sttErrorWindow.shift();
      }

      // Pause for 2s
      this.sttPaused = true;
      this.deps.clock.setTimeout(() => {
        this.sttPaused = false;
        // Drain buffered audio after pause
        for (const speaker of ["agent", "customer"] as Speaker[]) {
          const chunks = this.audioQueues[speaker].drain();
          for (const chunk of chunks) {
            this.safePushWithBackoff(chunk.pcm, speaker);
          }
        }
      }, STT_RATE_LIMIT_PAUSE_MS);

      if (this.sttErrorWindow.length >= STT_OVERLOAD_THRESHOLD) {
        void this.safe(async () => { await this.end("stt_overload"); });
      }
    }
  }

  private onDrop(speaker: Speaker): void {
    this.deps.metrics.audioQueueDropped.inc({ tenant: this.tenantId, speaker });
  }

  // ---------------------------------------------------------------------------
  // safe — per-session error boundary
  // ---------------------------------------------------------------------------
  private async safe(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.deps.logger.error({ err, tenantId: this.tenantId, conversationId: this.conversationId }, "session: unhandled error in handler — panic");
      // Avoid recursive panic
      if (!this._endCalled) {
        try {
          await this.end("panic");
        } catch (endErr) {
          this.deps.logger.error({ endErr }, "session: end(panic) itself threw");
        }
      }
    }
  }
}

export type SessionFactory = (record: SessionRecord) => Session;

export function makeSessionFactory(
  commonDeps: Omit<SessionDeps, "record">
): SessionFactory {
  return (record: SessionRecord): Session => new Session({ ...commonDeps, record });
}
