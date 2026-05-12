import * as http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { twilioFrame } from "./twilio-frames";
import { validateTwilioSignature } from "./twilio-frames";
import type { SessionStore, SessionRecord } from "../session/session-store";
import type { Session, SessionFactory } from "../session/session";
import type { Clock } from "../lib/clock";
import type { Logger } from "../lib/logger";
import type { Metrics } from "../metrics/metrics";
import type { VoiceProviderResolver } from "../providers/voice-provider";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { SessionFactory } from "../session/session";

export interface TwilioHandlerDeps {
  wss: WebSocketServer;
  store: SessionStore;
  sessionFactory: SessionFactory;
  clock: Clock;
  logger: Logger;
  metrics: Metrics;
  maxConcurrent: number;
  reconnectGraceMs?: number;
  /**
   * Preferred: resolve the VoiceProvider for the tenant and let it validate
   * the signature itself. If both this and the legacy `getTwilioAuthToken`/
   * `secureHmac` injections are provided, the resolver wins.
   */
  resolveProvider?: VoiceProviderResolver;
  /** Legacy injection point (kept for test compat). */
  getTwilioAuthToken?: (tenantId: string) => Promise<string>;
  /** Legacy injection point (kept for test compat). */
  secureHmac?: (sig: string | undefined, url: string, token: string) => boolean;
}

// Per-WS connection state
interface WsState {
  tenantId: string;
  session?: Session;
  streamSid?: string;
  callSid?: string;
  graceTimer?: { cancel(): void };
  /** Media frames that arrived before session was ready — replayed on bootstrap. */
  pendingMedia?: import("../session/session").MediaFrameParsed[];
  /** Conference-mode: fixed speaker for this WS (one participant = one speaker).
   *  Resolved from `customParameters.speaker` on the `start` frame. */
  fixedSpeaker?: import("../stt/provider").Speaker;
}

const PENDING_MEDIA_MAX = 200; // ≈ 4 s of 20 ms frames — covers the start-handler gap

// In-process map: callSid → { session, ws }
const liveSessionMap = new Map<string, { session: Session; ws: WebSocket }>();

const PATH_RE = /^\/twilio\/media-stream\/([^/?#]+)/;

// ---------------------------------------------------------------------------
// attachTwilioHandler
// ---------------------------------------------------------------------------

export function attachTwilioHandler(
  httpServer: http.Server,
  deps: TwilioHandlerDeps
): void {
  const {
    wss,
    store,
    sessionFactory,
    clock,
    logger,
    metrics,
    maxConcurrent,
  } = deps;

  const reconnectGraceMs = deps.reconnectGraceMs ?? 10_000;

  // Track active connections independently of wss.clients (testability)
  let activeConnections = 0;

  // Legacy injection points (kept for test compat — see TwilioHandlerDeps).
  const getToken: (tenantId: string) => Promise<string> =
    deps.getTwilioAuthToken ??
    (async (tenantId: string) => {
      const { getTwilioAuthToken } = await import("../config/secrets");
      return getTwilioAuthToken(tenantId);
    });
  const hmacCheck: (sig: string | undefined, url: string, token: string) => boolean =
    deps.secureHmac ??
    ((sig, url, token) => validateTwilioSignature(sig, url, token));

  // Validate the upgrade's signature, preferring the provider seam when
  // wired in. Two distinct failure shapes preserved from the pre-seam code:
  //   - "resolve_failed": credential/auth resolution exploded → silent destroy
  //   - "signature_mismatch": HMAC didn't verify → HTTP 401 then destroy
  type ValidateOutcome =
    | { kind: "ok" }
    | { kind: "resolve_failed"; err: unknown }
    | { kind: "signature_mismatch" };
  async function validateUpgrade(tenantId: string, sig: string | undefined, urls: string[]): Promise<ValidateOutcome> {
    if (deps.resolveProvider) {
      let valid: boolean;
      try {
        const provider = await deps.resolveProvider(tenantId);
        valid = provider.validateInboundSignature({ signature: sig, candidateUrls: urls });
      } catch (err) {
        return { kind: "resolve_failed", err };
      }
      return valid ? { kind: "ok" } : { kind: "signature_mismatch" };
    }
    // Legacy path — identical to the pre-seam implementation.
    let authToken: string;
    try {
      authToken = await getToken(tenantId);
    } catch (err) {
      return { kind: "resolve_failed", err };
    }
    return urls.some((u) => hmacCheck(sig, u, authToken))
      ? { kind: "ok" }
      : { kind: "signature_mismatch" };
  }

  // ------------------------------------------------------------------
  // HTTP upgrade listener
  // ------------------------------------------------------------------
  httpServer.on("upgrade", async (req: http.IncomingMessage, socket: import("net").Socket, head: Buffer) => {
    const url = req.url ?? "";
    const match = PATH_RE.exec(url);

    if (!match) {
      // Not our path — destroy without responding
      socket.destroy();
      return;
    }

    const tenantId = match[1];

    // Validate Twilio signature. For Media Streams, Twilio signs the URL
    // exactly as given in <Stream url="..."> — typically wss:// — but TLS
    // terminates upstream of nginx so we don't know the original scheme for
    // sure. Try every plausible variant before rejecting.
    const host = req.headers.host ?? "localhost";
    const sig = req.headers["x-twilio-signature"] as string | undefined;
    const urls = [
      `wss://${host}${req.url}`,
      `ws://${host}${req.url}`,
      `https://${host}${req.url}`,
      `http://${host}${req.url}`,
    ];
    const outcome = await validateUpgrade(tenantId, sig, urls);
    if (outcome.kind === "resolve_failed") {
      logger.warn({ err: outcome.err, tenantId }, "twilio-handler: failed to resolve auth token");
      metrics.twilioAuthRejected.inc();
      socket.destroy();
      return;
    }
    if (outcome.kind === "signature_mismatch") {
      logger.warn({ tenantId, urls, sig }, "twilio-handler: signature mismatch");
      metrics.twilioAuthRejected.inc();
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    // Valid upgrade — hand off to WS server
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, { tenantId });
    });
  });

  // ------------------------------------------------------------------
  // WebSocket connection handler
  // ------------------------------------------------------------------
  wss.on("connection", (ws: WebSocket, _req: http.IncomingMessage, ctx: {
    tenantId: string;
  }) => {
    const tenantId = ctx.tenantId;
    const state: WsState = { tenantId };

    // Enforce concurrency limit
    activeConnections++;

    if (activeConnections > maxConcurrent) {
      logger.warn({ tenantId }, "twilio-handler: overload — rejecting connection");
      metrics.voiceOverload.inc();
      activeConnections--;
      ws.close(1013, "overload");
      return;
    }

    logger.debug({ tenantId }, "twilio-handler: ws connected");

    // ----------------------------------------------------------------
    // Message handler
    // ----------------------------------------------------------------
    ws.on("message", async (raw: Buffer | string) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch (err) {
        logger.warn({ err, tenantId }, "twilio-handler: invalid JSON frame");
        return;
      }

      const result = twilioFrame.safeParse(parsed);
      if (!result.success) {
        logger.warn({ issues: result.error.issues, tenantId }, "twilio-handler: frame schema mismatch");
        return;
      }

      const frame = result.data;

      try {
        switch (frame.event) {
          case "connected": {
            logger.debug({ tenantId, protocol: frame.protocol }, "twilio-handler: connected frame");
            break;
          }

          case "start": {
            const { callSid, customParameters } = frame.start;
            const streamSid = frame.streamSid;
            const conversationId = customParameters?.conversationId;
            const agentId = customParameters?.agentId;
            const cpTenantId = customParameters?.tenantId;
            // Conference-mode per-participant streams carry a `speaker`
            // parameter (agent|customer). If present, it's authoritative for
            // every frame on this WS.
            const cpSpeaker = customParameters?.speaker;
            if (cpSpeaker === "agent" || cpSpeaker === "customer") {
              state.fixedSpeaker = cpSpeaker;
            }

            // Cross-tenant check (only when customParameters carried tenant)
            if (cpTenantId && cpTenantId !== tenantId) {
              logger.warn({ tenantId, cpTenantId }, "twilio-handler: cross-tenant violation");
              metrics.crossTenantRejected.inc();
              ws.close(1008, "cross_tenant");
              return;
            }

            if (!conversationId) {
              logger.warn({ tenantId }, "twilio-handler: start frame missing conversationId");
              ws.close(1008, "missing_conversation_id");
              return;
            }

            state.callSid = callSid;
            state.streamSid = streamSid;

            // Attempt reconnect first
            const existingConvId = await store.findByCallSid(tenantId, callSid);
            if (existingConvId) {
              const reclaimed = await store.reconnectClaim(
                tenantId,
                existingConvId,
                clock.now(),
                reconnectGraceMs
              );
              if (reclaimed) {
                // Reuse live session if still in map
                const live = liveSessionMap.get(callSid);
                if (live) {
                  // Cancel any pending grace timer
                  if (state.graceTimer) {
                    state.graceTimer.cancel();
                    state.graceTimer = undefined;
                  }
                  state.session = live.session;
                  // Update the map to point to new ws
                  liveSessionMap.set(callSid, { session: live.session, ws });
                  await live.session.resumeFromReconnect();
                  metrics.reconnects.inc({ tenant: tenantId });
                  logger.info({ tenantId, callSid }, "twilio-handler: reconnect claimed");
                  if (state.pendingMedia && state.pendingMedia.length > 0) {
                    const buffered = state.pendingMedia;
                    state.pendingMedia = undefined;
                    for (const f of buffered) {
                      try { await live.session.handleMediaFrame(f); } catch { /* ignore */ }
                    }
                  }
                  break;
                }
              }
            }

            // New session
            const record: SessionRecord = {
              tenantId,
              conversationId,
              callSid,
              streamSid,
              agentId,
              state: "ringing",
              startedAt: clock.now(),
              lastFrameAt: clock.now(),
              reconnectCount: 0,
              framesReceived: 0,
              framesDropped: 0,
              transcriptsEmitted: 0,
            };

            const session = sessionFactory(record);
            state.session = session;
            liveSessionMap.set(callSid, { session, ws });

            await session.bootstrap();
            logger.info({ tenantId, callSid, conversationId }, "twilio-handler: session bootstrapped");

            // Replay any media frames that arrived during the async bootstrap.
            // Yield to the event loop between frames so live frames arriving
            // concurrently interleave cleanly — no replay-burst starvation.
            if (state.pendingMedia && state.pendingMedia.length > 0) {
              const buffered = state.pendingMedia;
              state.pendingMedia = undefined;
              logger.info({ tenantId, count: buffered.length }, "twilio-handler: replaying buffered media frames");
              for (const f of buffered) {
                try { await session.handleMediaFrame(f, state.fixedSpeaker); } catch { /* non-fatal */ }
                await new Promise<void>((r) => setImmediate(r));
              }
            }
            break;
          }

          case "media": {
            const mediaFrame = frame as import("../session/session").MediaFrameParsed;
            if (!state.session) {
              // Session not ready yet — buffer, don't drop. Drop-oldest on overflow.
              if (!state.pendingMedia) state.pendingMedia = [];
              if (state.pendingMedia.length >= PENDING_MEDIA_MAX) {
                state.pendingMedia.shift();
              }
              state.pendingMedia.push(mediaFrame);
              return;
            }
            try {
              await state.session.handleMediaFrame(mediaFrame, state.fixedSpeaker);
            } catch (err) {
              logger.error({ err, tenantId }, "twilio-handler: handleMediaFrame threw");
              await state.session.end("panic");
              if (state.callSid) liveSessionMap.delete(state.callSid);
            }
            break;
          }

          case "stop": {
            if (state.session) {
              try {
                await state.session.handleStop();
              } catch (err) {
                logger.error({ err, tenantId }, "twilio-handler: handleStop threw");
              }
              if (state.callSid) liveSessionMap.delete(state.callSid);
              state.session = undefined;
            }
            break;
          }

          case "mark": {
            logger.debug({ tenantId, name: frame.mark.name }, "twilio-handler: mark frame");
            break;
          }
        }
      } catch (err) {
        logger.error({ err, tenantId, event: frame.event }, "twilio-handler: unhandled error in frame handler");
      }
    });

    // ----------------------------------------------------------------
    // Close handler — schedule grace period
    // ----------------------------------------------------------------
    ws.on("close", async () => {
      activeConnections = Math.max(0, activeConnections - 1);
      logger.debug({ tenantId, callSid: state.callSid }, "twilio-handler: ws closed");

      if (!state.session || state.session.state === "ended") {
        return;
      }

      const session = state.session;
      const callSid = state.callSid;

      // Schedule grace timer — if it fires without reconnect, end session
      state.graceTimer = clock.setTimeout(async () => {
        if (session.state !== "ended") {
          try {
            await session.end("ws_closed");
          } catch (err) {
            logger.error({ err, tenantId }, "twilio-handler: grace timer end threw");
          }
        }
        if (callSid) liveSessionMap.delete(callSid);
      }, reconnectGraceMs);
    });

    // ----------------------------------------------------------------
    // Error handler
    // ----------------------------------------------------------------
    ws.on("error", (err: Error) => {
      logger.warn({ err, tenantId }, "twilio-handler: ws error");
    });
  });
}
