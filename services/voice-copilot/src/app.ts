/**
 * app.ts — Central factory for the voice-copilot service.
 *
 * EXTENSION POINTS FOR DOWNSTREAM PACKETS:
 *   W4 (session/reaper): edit buildDefaultDeps to replace stub SessionStore,
 *       Reaper, SessionFactory with real implementations.
 *   W5 (stt):            edit buildDefaultDeps to replace stub sttFactory with
 *       buildSTTProvider from ./stt/stt-factory.
 *   W6 (dispatcher):     edit buildDefaultDeps to replace stub Dispatcher with
 *       new Dispatcher(deps).
 *   W7 (ws-handler):     no app.ts edit needed — attachTwilioHandler is already
 *       called here; W7 just fills in the function body.
 *   W8 (routes/live):    mount the live router inside createApp, referencing
 *       deps.sessionStore.
 *
 * This is the ONE file that downstream packets are permitted to edit after W2.
 * All other files under src/ are owned by their respective work packet.
 */

import express from "express";
import * as http from "http";
import { WebSocketServer } from "ws";
import { getRedis, publishEvent as sharedPublishEvent } from "@chatcenter/shared";
import type { ServiceEvent } from "@chatcenter/shared";
import type { Redis } from "ioredis";

import { loadEnv, type Env } from "./config/env";
import { logger as rootLogger, type Logger } from "./lib/logger";
import { systemClock, type Clock } from "./lib/clock";
import { seededRandom } from "./lib/random";
import { buildMetrics, type Metrics, type Registry } from "./metrics/metrics";
import { createHealthRouter } from "./routes/health";
import { createMetricsRouter } from "./routes/metrics";
import { createLiveRouter } from "./routes/live";
import { createTwilioTokenRouter } from "./routes/twilio-token";
import { createTwilioTwimlRouter } from "./routes/twilio-twiml";

import { createSessionStore, type SessionStore } from "./session/session-store";
import { Reaper } from "./session/reaper";
import { makeSessionFactory, type SessionFactory } from "./session/session";
import { Dispatcher } from "./dispatch/dispatcher";
import { postVoiceStream } from "./dispatch/ai-assist-client";
import { attachTwilioHandler } from "./ws/twilio-handler";
import type { STTProvider, SttConfig } from "./stt/provider";
import { buildSTTProvider } from "./stt/stt-factory";

export type AiAssistClient = typeof postVoiceStream;

// Re-export types for downstream use
export type { SessionFactory } from "./session/session";

export interface AppDeps {
  redis: Redis;
  clock: Clock;
  random: () => number;
  logger: Logger;
  metrics: Metrics;
  /** W5 supplies real factory; W2 default throws NotImplementedError on use */
  sttFactory: (cfg: SttConfig) => STTProvider;
  /** W6 supplies impl; W2 default throws NotImplementedError on use */
  dispatcher: Dispatcher;
  /** W4 supplies; W2 default throws NotImplementedError on use */
  sessionStore: SessionStore;
  /** W4 supplies; W2 default throws NotImplementedError on use */
  reaper: Reaper;
  /** W4 supplies; W2 default throws NotImplementedError on use */
  sessionFactory: SessionFactory;
  /** W6 supplies; W2 default throws NotImplementedError on use */
  aiAssistClient: AiAssistClient;
  publishEvent: (e: ServiceEvent) => Promise<void>;
}

export interface BuiltApp {
  app: express.Express;
  httpServer: http.Server;
  wss: WebSocketServer;
  reaper: Reaper;
  dispatcher: Dispatcher;
  sessionStore: SessionStore;
  registry: Registry;
  shutdown: () => Promise<void>;
}

/**
 * buildDefaultDeps — constructs all dependencies from environment.
 *
 * Stubs that throw NotImplementedError are placeholders for W4/W5/W6.
 * Downstream packets replace them by editing this function (documented
 * as the only acceptable post-W2 edit to app.ts).
 */
export function buildDefaultDeps(env: Env): AppDeps {
  const redis = getRedis();
  const clock = systemClock;
  const random = seededRandom(env.STT_STUB_SEED);
  const metrics = buildMetrics();

  // --- W4: real session-store, reaper, session-factory ---
  const sessionStore = createSessionStore(redis);

  // TODO W7: when twilio-handler lands it owns the live-session map and will
  // pass its own endSession callback via createApp({...overrides}).
  // For now, the default endSession only updates store state + publishes an
  // event. The reaper.start() call below is left active — W7 will override
  // endSession via the overrides mechanism.
  const reaper = new Reaper({
    store: sessionStore,
    redis,
    clock,
    logger: rootLogger,
    metrics,
    intervalMs: env.REAPER_INTERVAL_MS,
    staleMs: env.REAPER_STALE_THRESHOLD_MS,
    endSession: async (tenantId: string, conversationId: string, _reason: "reaper") => {
      // Thin default: mark state ended + publish event.
      // W7 replaces this with session.end("reaper") on the live Session object.
      await sessionStore.updateState(tenantId, conversationId, "ended");
      await sharedPublishEvent({
        event: "voice.session.ended",
        tenantId,
        data: { conversationId, reason: "reaper", ts: clock.now() },
      });
    },
  });

  const sttFactoryReal = (cfg: SttConfig): STTProvider =>
    buildSTTProvider({
      provider: cfg.provider,
      seed: cfg.seed,
      clock,
      apiKey: cfg.apiKey,
    });

  const sessionFactory = makeSessionFactory({
    store: sessionStore,
    sttFactory: sttFactoryReal,
    sttConfig: {
      provider: env.STT_PROVIDER,
      language: "he-IL",
      interimResults: true,
      seed: env.STT_STUB_SEED,
      apiKey: env.STT_PROVIDER === "deepgram" ? env.DEEPGRAM_API_KEY : undefined,
    },
    dispatcher: new Dispatcher({
      client: postVoiceStream as unknown as (body: unknown, opts: unknown) => Promise<unknown>,
      redis,
      aiServiceUrl: env.AI_SERVICE_URL,
      internalKey: env.INTERNAL_SERVICE_KEY,
      clock,
      logger: rootLogger,
      metrics,
      batchWindowMs: env.DISPATCHER_BATCH_WINDOW_MS,
      batchMax: env.DISPATCHER_BATCH_MAX,
      retryScheduleMs: [250, 500, 1000, 2000, 4000],
    }),
    clock,
    logger: rootLogger,
    metrics,
    eventBus: { publish: sharedPublishEvent },
  });

  // --- W6 stub (dispatcher) ---
  const dispatcher = new Dispatcher({
    client: postVoiceStream as unknown as (body: unknown, opts: unknown) => Promise<unknown>,
    redis,
    aiServiceUrl: env.AI_SERVICE_URL,
    internalKey: env.INTERNAL_SERVICE_KEY,
    clock,
    logger: rootLogger,
    metrics,
    batchWindowMs: env.DISPATCHER_BATCH_WINDOW_MS,
    batchMax: env.DISPATCHER_BATCH_MAX,
    retryScheduleMs: [250, 500, 1000, 2000, 4000],
  });

  return {
    redis,
    clock,
    random,
    logger: rootLogger,
    metrics,
    sttFactory: sttFactoryReal,
    dispatcher,
    sessionStore,
    reaper,
    sessionFactory,
    aiAssistClient: postVoiceStream,
    publishEvent: sharedPublishEvent,
  };
}

let _env: Env | undefined;

function getEnv(): Env {
  if (!_env) {
    _env = loadEnv();
  }
  return _env;
}

/**
 * createApp — testable factory.
 *
 * Pass `overrides` to inject mocks/real impls in tests and in downstream
 * work packets that swap in their modules.
 */
export function createApp(overrides?: Partial<AppDeps>): BuiltApp {
  const env = getEnv();
  const deps: AppDeps = { ...buildDefaultDeps(env), ...overrides };

  // 1. Express app
  const app = express();
  app.use(express.json());

  // Track whether STT is initialized (for /readyz — W5 will set this)
  let sttInitialized = false;
  const markSttReady = () => { sttInitialized = true; };
  void markSttReady; // used by W5

  // 2. Mount routes
  app.use("/", createHealthRouter({
    redis: deps.redis,
    ready: () => sttInitialized || env.STT_PROVIDER === "stub",
    // stub provider is always "ready"; google requires explicit signal from W5
  }));
  app.use("/", createMetricsRouter(deps.metrics.registry));

  app.use("/api/voice-copilot/live", createLiveRouter({ redis: deps.redis, logger: deps.logger }));
  app.use("/api/voice-copilot/token", createTwilioTokenRouter({ env, logger: deps.logger }));
  app.use("/api/voice-copilot/twiml", createTwilioTwimlRouter({ env, logger: deps.logger }));

  // 3. HTTP server
  const httpServer = http.createServer(app);

  // 4. WebSocket server (noServer mode — upgrade handled by attachTwilioHandler)
  const wss = new WebSocketServer({ noServer: true });

  // 5. Wire Twilio WS upgrade handler
  attachTwilioHandler(httpServer, {
    wss,
    store: deps.sessionStore,
    sessionFactory: deps.sessionFactory,
    clock: deps.clock,
    logger: deps.logger,
    metrics: deps.metrics,
    maxConcurrent: env.MAX_CONCURRENT_SESSIONS,
    reconnectGraceMs: env.RECONNECT_GRACE_MS,
  });

  // 6. Start reaper (safe: Reaper.start() is a no-op stub until W4 lands)
  try {
    deps.reaper.start();
  } catch {
    // W4 not yet landed — reaper start is a stub; continue booting
  }

  // 7. Shutdown
  async function shutdown(): Promise<void> {
    deps.logger.info("voice-copilot shutting down");
    try { deps.reaper.stop(); } catch { /* stub */ }
    await new Promise<void>((resolve, reject) =>
      wss.close((err) => (err ? reject(err) : resolve()))
    );
    await new Promise<void>((resolve, reject) =>
      httpServer.close((err) => (err ? reject(err) : resolve()))
    );
  }

  return {
    app,
    httpServer,
    wss,
    reaper: deps.reaper,
    dispatcher: deps.dispatcher,
    sessionStore: deps.sessionStore,
    registry: deps.metrics.registry,
    shutdown,
  };
}
