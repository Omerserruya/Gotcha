/**
 * Deepgram streaming STT provider (SDK v3, `listen.live`).
 *
 * Flow per speaker (one Deepgram WS each):
 *   push(pcm) → if WS open → client.send() directly (zero queue lag).
 *             → if WS opening/reconnecting → preOpenBuffer (drop-oldest cap 200).
 *   Open event → flush preOpenBuffer in order, start keepalive.
 *
 * Transcript:
 *   is_final=false → partial (UI live line only, not persisted).
 *   is_final=true  → final (persisted as Message); dedupe via lastFinalText.
 *   Deepgram config: endpointing 500 ms + utterance_end_ms 1000 ms → finals
 *   fire promptly after silence so short utterances commit before next speech
 *   overrides the live line.
 *
 * Resilience:
 *   Close / retryable Error while session still running → reconnect with
 *   exponential backoff (500 ms → 5 s cap). Client is swapped in-place; the
 *   channel state (seq counter, lastFinalText, preOpenBuffer) is preserved,
 *   so dedupe + ordering survive the reconnect.
 */
import { createClient, LiveTranscriptionEvents, type LiveClient } from "@deepgram/sdk";
import {
  STTProvider,
  SttSessionContext,
  SttStream,
  Transcript,
  SttError,
  Speaker,
} from "./provider";
import { logger as rootLogger } from "../lib/logger";

// Shared child-logger — per-call hot-path logs go through pino (async, level-gated)
// instead of synchronous console.log which blocks stdout and caused 10–15 s
// latency growth on long calls.
const log = rootLogger.child({ module: "deepgram" });

interface PerSpeakerChannel {
  client: LiveClient;
  seq: number;
  /** Dedupe guard — skip emitting a final whose text exactly matches the last one. */
  lastFinalText: string;
  /** Latest interim text — flushed on UtteranceEnd or silence-flush timer. */
  pendingInterimText: string;
  /** Silence-flush timer — if no new partial for SILENCE_FLUSH_MS, commit pending. */
  flushTimer: ReturnType<typeof setTimeout> | null;
  partialCb: ((t: Transcript) => void) | null;
  finalCb: ((t: Transcript) => void) | null;
  errorCb: ((e: SttError) => void) | null;
  keepalive: ReturnType<typeof setInterval> | null;
  open: boolean;
  /** True once `close()` is called — no more sends, no reconnect attempts. */
  closed: boolean;
  /**
   * Frames received before the Deepgram socket is OPEN. Drained in order on
   * Open. Bounded with drop-oldest so a never-opening socket can't leak RAM.
   */
  preOpenBuffer: ArrayBuffer[];
  overflowLogged: boolean;
  reconnecting: boolean;
  reconnectAttempts: number;
  /** Info-once marker so we know Deepgram actually returned something. */
  firstTranscriptLogged: boolean;
  /** Running count of audio frames sent — sampled log every SEND_LOG_EVERY. */
  framesSent: number;
}

/** If no partial arrives for this long, commit the pending interim as final. */
const SILENCE_FLUSH_MS = 1200;

/** Pre-open buffer cap — drop-oldest beyond this. ≈ 4 s of 20 ms frames. */
const PRE_OPEN_BUFFER_MAX = 200;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mapDeepgramLanguage(lang: SttSessionContext["language"]): { language: string; model: string } {
  if (lang === "he-IL") return { language: "he", model: "nova-3" };
  return { language: "en-US", model: "nova-3" };
}

export class DeepgramSTTProvider implements STTProvider {
  constructor(private readonly apiKey: string) {}

  async start(ctx: SttSessionContext): Promise<SttStream> {
    if (!this.apiKey) {
      log.error("start: API key missing");
      throw new Error("deepgram_api_key_missing");
    }
    log.info({ conversationId: ctx.conversationId, language: ctx.language }, "start");
    const deepgram = createClient(this.apiKey);

    const channels: Record<Speaker, PerSpeakerChannel> = {
      agent: buildChannel(deepgram, ctx, "agent"),
      customer: buildChannel(deepgram, ctx, "customer"),
    };

    const stream: SttStream = {
      push(pcm: Int16Array, speaker: Speaker): void {
        const ch = channels[speaker];
        if (!ch || ch.closed) return;
        const ab = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer;
        if (ch.open) {
          // Live path — send immediately. Deepgram's WS buffers internally;
          // adding our own pacing was slower than the Twilio producer rate
          // and caused runaway queue lag.
          try { ch.client.send(ab); } catch { /* surfaces via Error */ }
          ch.framesSent++;
          // Diagnostic: confirm audio is actually reaching Deepgram. Log at
          // 1, 50, 500, 2500 frames so the absence of activity is obvious.
          if (ch.framesSent === 1 || ch.framesSent === 50 || ch.framesSent === 500 || ch.framesSent === 2500) {
            log.info({ speaker, conversationId: ctx.conversationId, framesSent: ch.framesSent, bytes: ab.byteLength }, "audio frames sent to deepgram");
          }
          return;
        }
        // Deepgram WS still opening (or reconnecting) — buffer with drop-oldest.
        if (ch.preOpenBuffer.length >= PRE_OPEN_BUFFER_MAX) {
          ch.preOpenBuffer.shift();
          if (!ch.overflowLogged) {
            ch.overflowLogged = true;
            log.warn({ speaker }, "pre-open overflow — dropping oldest frames");
          }
        }
        ch.preOpenBuffer.push(ab);
      },
      async close(): Promise<void> {
        for (const speaker of ["agent", "customer"] as Speaker[]) {
          const ch = channels[speaker];
          ch.closed = true;
          if (ch.keepalive) clearInterval(ch.keepalive);
          if (ch.flushTimer) { clearTimeout(ch.flushTimer); ch.flushTimer = null; }
          // Force-commit any pending interim as a final so the last utterance
          // survives the hangup — otherwise the building line on the UI dies
          // mid-word and never lands in the message list.
          const pending = ch.pendingInterimText.trim();
          if (pending && pending !== ch.lastFinalText) {
            ch.lastFinalText = pending;
            ch.pendingInterimText = "";
            emit(ch, speaker, pending, true, 1);
          }
          ch.preOpenBuffer = [];
          try { ch.client.requestClose(); } catch { /* ignore */ }
        }
      },
      on(event, cb): void {
        if (event === "partial") {
          for (const s of ["agent", "customer"] as Speaker[]) channels[s].partialCb = cb as any;
        } else if (event === "final") {
          for (const s of ["agent", "customer"] as Speaker[]) channels[s].finalCb = cb as any;
        } else if (event === "error") {
          for (const s of ["agent", "customer"] as Speaker[]) channels[s].errorCb = cb as any;
        }
      },
    };

    return stream;
  }
}

// ---------------------------------------------------------------------------
// Channel construction + lifecycle
// ---------------------------------------------------------------------------

function buildListenLive(deepgram: ReturnType<typeof createClient>, ctx: SttSessionContext): LiveClient {
  const { language, model } = mapDeepgramLanguage(ctx.language);
  return deepgram.listen.live({
    model,
    language,
    encoding: "linear16",
    sample_rate: 8000,
    channels: 1,
    interim_results: true,
    smart_format: true,
    // UtteranceEnd fires after 1000 ms of silence. We use THAT event (not
    // `endpointing`, which produced zero finals on Hebrew telephony audio)
    // to force-commit the latest interim when the speaker pauses.
    utterance_end_ms: 1000,
  });
}

function buildChannel(
  deepgram: ReturnType<typeof createClient>,
  ctx: SttSessionContext,
  speaker: Speaker,
): PerSpeakerChannel {
  const ch: PerSpeakerChannel = {
    client: buildListenLive(deepgram, ctx),
    seq: 0,
    lastFinalText: "",
    pendingInterimText: "",
    flushTimer: null,
    partialCb: null,
    finalCb: null,
    errorCb: null,
    keepalive: null,
    open: false,
    closed: false,
    preOpenBuffer: [],
    overflowLogged: false,
    reconnecting: false,
    reconnectAttempts: 0,
    firstTranscriptLogged: false,
    framesSent: 0,
  };
  attachHandlers(ch, deepgram, ctx, speaker);
  return ch;
}

function attachHandlers(
  ch: PerSpeakerChannel,
  deepgram: ReturnType<typeof createClient>,
  ctx: SttSessionContext,
  speaker: Speaker,
): void {
  const client = ch.client;

  client.on(LiveTranscriptionEvents.Transcript, (data: any) => {
    const alt = data?.channel?.alternatives?.[0];
    if (!alt) return;
    const text = String(alt.transcript || "").trim();
    if (!text) return;

    const isFinal = Boolean(data.is_final);
    const confidence = Number(alt.confidence ?? 0);

    if (!ch.firstTranscriptLogged) {
      ch.firstTranscriptLogged = true;
      log.info({ speaker, conversationId: ctx.conversationId, isFinal }, "first transcript received");
    }

    // Any real activity cancels the pending silence flush.
    if (ch.flushTimer) { clearTimeout(ch.flushTimer); ch.flushTimer = null; }

    if (isFinal) {
      if (text === ch.lastFinalText) return;
      ch.lastFinalText = text;
      ch.pendingInterimText = "";
      emit(ch, speaker, text, true, confidence);
    } else {
      ch.pendingInterimText = text;
      emit(ch, speaker, text, false, confidence);
      // Arm silence flush — if no new partial arrives within SILENCE_FLUSH_MS
      // we treat the current interim as a final. Catches Hebrew telephony
      // cases where Deepgram's native `is_final` / `UtteranceEnd` are sluggish.
      ch.flushTimer = setTimeout(() => {
        ch.flushTimer = null;
        const pending = ch.pendingInterimText.trim();
        if (!pending || pending === ch.lastFinalText) return;
        ch.lastFinalText = pending;
        ch.pendingInterimText = "";
        emit(ch, speaker, pending, true, 1);
      }, SILENCE_FLUSH_MS);
    }
  });

  // UtteranceEnd fires after `utterance_end_ms` of silence from Deepgram.
  // Belt-and-suspenders with the client-side silence flush above.
  client.on(LiveTranscriptionEvents.UtteranceEnd, () => {
    if (ch.flushTimer) { clearTimeout(ch.flushTimer); ch.flushTimer = null; }
    const text = ch.pendingInterimText.trim();
    if (!text || text === ch.lastFinalText) return;
    ch.lastFinalText = text;
    ch.pendingInterimText = "";
    emit(ch, speaker, text, true, 1);
  });

  client.on(LiveTranscriptionEvents.Error, (err: any) => {
    log.error({ speaker, err: err?.message || String(err) }, "stt error");
    const mapped = mapDeepgramError(err);
    ctx.onError(mapped);
    if (ch.errorCb) { try { ch.errorCb(mapped); } catch { /* ignore */ } }
    if (!ch.closed && mapped.retryable) {
      void scheduleReconnect(ch, deepgram, ctx, speaker);
    }
  });

  client.on(LiveTranscriptionEvents.Close, (ev: any) => {
    log.debug({ speaker, code: ev?.code }, "stt closed");
    ch.open = false;
    if (ch.keepalive) { clearInterval(ch.keepalive); ch.keepalive = null; }
    // If the session is still active, attempt reconnect.
    if (!ch.closed) {
      void scheduleReconnect(ch, deepgram, ctx, speaker);
    }
  });

  client.on(LiveTranscriptionEvents.Open, () => {
    if (ch.reconnectAttempts > 0) {
      log.warn({ speaker, attempt: ch.reconnectAttempts, buffered: ch.preOpenBuffer.length }, "stt reconnect succeeded");
    } else {
      log.info({ speaker, conversationId: ctx.conversationId, buffered: ch.preOpenBuffer.length }, "stt opened");
    }
    ch.open = true;
    ch.reconnectAttempts = 0;
    ch.keepalive = setInterval(() => {
      if (ch.open) { try { ch.client.keepAlive(); } catch { /* ignore */ } }
    }, 8000);
    // Flush pre-open buffer in order.
    const buffered = ch.preOpenBuffer;
    ch.preOpenBuffer = [];
    for (const buf of buffered) {
      try { ch.client.send(buf); } catch { /* ignore */ }
    }
  });
}

async function scheduleReconnect(
  ch: PerSpeakerChannel,
  deepgram: ReturnType<typeof createClient>,
  ctx: SttSessionContext,
  speaker: Speaker,
): Promise<void> {
  if (ch.reconnecting || ch.closed) return;
  ch.reconnecting = true;
  const attempt = ch.reconnectAttempts + 1;
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS);
  log.warn({ speaker, attempt, delayMs: delay }, "stt reconnect scheduled");
  await sleep(delay);
  if (ch.closed) { ch.reconnecting = false; return; }
  try {
    ch.client = buildListenLive(deepgram, ctx);
    attachHandlers(ch, deepgram, ctx, speaker);
    ch.reconnectAttempts = attempt;
  } catch (err) {
    log.error({ speaker, attempt, err: (err as any)?.message || String(err) }, "stt reconnect failed");
    ch.reconnectAttempts = attempt;
    ch.reconnecting = false;
    void scheduleReconnect(ch, deepgram, ctx, speaker);
    return;
  }
  ch.reconnecting = false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emit(
  ch: PerSpeakerChannel,
  speaker: Speaker,
  text: string,
  isFinal: boolean,
  confidence: number,
): void {
  ch.seq += 1;
  const t: Transcript = {
    speaker,
    text,
    timestamp: Date.now(),
    isFinal,
    confidence: Number.isFinite(confidence) ? confidence : 0,
    seq: ch.seq,
  };
  const fn = isFinal ? ch.finalCb : ch.partialCb;
  if (fn) { try { fn(t); } catch { /* swallow */ } }
}

function mapDeepgramError(err: any): SttError {
  const msg = err?.message || String(err ?? "deepgram_error");
  if (/429|rate/i.test(msg)) return { code: "RATE_LIMIT", message: msg, retryable: true };
  if (/401|403|auth/i.test(msg)) return { code: "AUTH", message: msg, retryable: false };
  if (/timeout/i.test(msg)) return { code: "TIMEOUT", message: msg, retryable: true };
  if (/unavailable|503/i.test(msg)) return { code: "UNAVAILABLE", message: msg, retryable: true };
  return { code: "INTERNAL", message: msg, retryable: true };
}
