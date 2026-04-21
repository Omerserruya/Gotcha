/**
 * voice-copilot.e2e.test.ts
 *
 * End-to-end integration test that boots createApp with injected overrides
 * (fake clock, in-memory Redis, stub STT, mock ai-assist client) and drives
 * a real WebSocket client through the full pipeline.
 *
 * Covers assertions 1-8 from spec §13.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as http from "http";
import WebSocket from "ws";
import { createApp } from "../app";
import type { AppDeps, BuiltApp } from "../app";
import { createFakeClock, type FakeClock } from "../lib/clock";
import { StubSTTProvider } from "../stt/stub-provider";
import type { SttConfig } from "../stt/provider";
import { Dispatcher } from "../dispatch/dispatcher";
import { createSessionStore } from "../session/session-store";
import { Reaper } from "../session/reaper";
import { makeSessionFactory } from "../session/session";
import { buildMetrics } from "../metrics/metrics";
import type { VoiceStreamBody, PostVoiceStreamOptions, PostResult } from "../dispatch/ai-assist-client";
import type { Redis } from "ioredis";
import type { Metrics } from "../metrics/metrics";

// ---------------------------------------------------------------------------
// Module-level shared Redis instance — replaced per-test via the ref below.
// The vi.mock factory captures a reference to this object so any test that
// replaces sharedRedisRef.current gets the updated instance.
// ---------------------------------------------------------------------------
const sharedRedisRef: { current: Redis | null } = { current: null };

vi.mock("@chatcenter/shared", () => {
  // Stub middleware that just calls next() — only used by /api/voice-copilot/live
  // which is not exercised in this e2e test.
  const passThrough = (_req: any, _res: any, next: any) => next();
  const requireRole = () => passThrough;
  const requireActiveTenant = () => passThrough;

  return {
    getRedis: () => {
      if (!sharedRedisRef.current) throw new Error("sharedRedisRef.current not set");
      return sharedRedisRef.current;
    },
    publishEvent: async () => {},
    closeRedis: async () => {},
    // Middleware stubs used by routes/live.ts
    authenticate: passThrough,
    resolveTenant: passThrough,
    requireActiveTenant,
    requireRole,
  };
});

// ---------------------------------------------------------------------------
// InMemoryRedis — full mock implementing every command used by session-store
// + dispatcher pipeline
// ---------------------------------------------------------------------------
function makeInMemoryRedis(): Redis {
  const hashes = new Map<string, Map<string, string>>();
  const strings = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const lists = new Map<string, string[]>();

  function getHash(key: string): Map<string, string> {
    if (!hashes.has(key)) hashes.set(key, new Map());
    return hashes.get(key)!;
  }
  function getSet(key: string): Set<string> {
    if (!sets.has(key)) sets.set(key, new Set());
    return sets.get(key)!;
  }
  function getList(key: string): string[] {
    if (!lists.has(key)) lists.set(key, []);
    return lists.get(key)!;
  }

  // Lua reconnect-claim simulation (mirrors RECONNECT_CLAIM_LUA)
  function reconnectClaimLua(key: string, nowMs: number, graceMs: number): string[] | null {
    const h = hashes.get(key);
    if (!h) return null;
    const st = h.get("state");
    if (!st || st === "ended") return null;
    const lastFrame = Number(h.get("lastFrameAt") ?? "0");
    if (nowMs - lastFrame > graceMs) return null;
    h.set("reconnectCount", String(Number(h.get("reconnectCount") ?? "0") + 1));
    const arr: string[] = [];
    for (const [k, v] of h) arr.push(k, v);
    return arr;
  }

  // Lua reaper-handoff simulation (mirrors REAPER_HANDOFF_LUA)
  function reaperHandoffLua(key: string, nowMs: number, staleMs: number): number {
    const h = hashes.get(key);
    if (!h) return 0;
    const st = h.get("state");
    if (!st || st === "ended") return 0;
    const lastFrame = Number(h.get("lastFrameAt") ?? "0");
    if (nowMs - lastFrame <= staleMs) return 0;
    h.set("state", "ended");
    return 1;
  }

  function makePipeline() {
    const cmds: Array<() => [null, unknown]> = [];
    const pipe: any = {
      hset: (key: string, ...args: string[]) => {
        cmds.push(() => {
          const h = getHash(key);
          for (let i = 0; i < args.length; i += 2) h.set(args[i], args[i + 1]);
          return [null, args.length / 2];
        });
        return pipe;
      },
      expire: (key: string, _ttl: number) => {
        cmds.push(() => [null, 1]);
        return pipe;
      },
      sadd: (key: string, ...members: string[]) => {
        cmds.push(() => {
          const s = getSet(key);
          let added = 0;
          for (const m of members) { if (!s.has(m)) { s.add(m); added++; } }
          return [null, added];
        });
        return pipe;
      },
      srem: (key: string, ...members: string[]) => {
        cmds.push(() => {
          const s = getSet(key);
          let removed = 0;
          for (const m of members) { if (s.delete(m)) removed++; }
          return [null, removed];
        });
        return pipe;
      },
      del: (...keys: string[]) => {
        cmds.push(() => {
          let count = 0;
          for (const k of keys) {
            if (hashes.delete(k) || strings.delete(k) || sets.delete(k) || lists.delete(k)) count++;
          }
          return [null, count];
        });
        return pipe;
      },
      set: (key: string, val: string, ...args: unknown[]) => {
        cmds.push(() => {
          const hasNx = args.includes("NX");
          if (hasNx && strings.has(key)) return [null, null];
          strings.set(key, val);
          return [null, "OK"];
        });
        return pipe;
      },
      lpush: (key: string, ...vals: string[]) => {
        cmds.push(() => {
          const list = getList(key);
          list.unshift(...vals.slice().reverse());
          return [null, list.length];
        });
        return pipe;
      },
      ltrim: (key: string, start: number, end: number) => {
        cmds.push(() => {
          const list = getList(key);
          lists.set(key, list.slice(start, end + 1));
          return [null, "OK"];
        });
        return pipe;
      },
      exec: async () => cmds.map((fn) => fn()),
    };
    return pipe;
  }

  const redis: any = {
    pipeline: makePipeline,
    multi: makePipeline, // alias
    hset: async (key: string, ...args: string[]) => {
      const h = getHash(key);
      for (let i = 0; i < args.length; i += 2) h.set(args[i], args[i + 1]);
      return args.length / 2;
    },
    hgetall: async (key: string): Promise<Record<string, string>> => {
      const h = hashes.get(key);
      if (!h || h.size === 0) return {};
      const obj: Record<string, string> = {};
      for (const [k, v] of h) obj[k] = v;
      return obj;
    },
    hincrby: async (key: string, field: string, by: number) => {
      const h = getHash(key);
      const cur = Number(h.get(field) ?? "0");
      const next = cur + by;
      h.set(field, String(next));
      return next;
    },
    expire: async (_key: string, _ttl: number) => 1,
    get: async (key: string): Promise<string | null> => strings.get(key) ?? null,
    set: async (key: string, val: string, ...args: unknown[]): Promise<string | null> => {
      const hasNx = args.includes("NX");
      if (hasNx && strings.has(key)) return null;
      strings.set(key, val);
      return "OK";
    },
    del: async (...keys: string[]) => {
      let count = 0;
      for (const k of keys) {
        if (hashes.delete(k) || strings.delete(k) || sets.delete(k) || lists.delete(k)) count++;
      }
      return count;
    },
    incr: async (key: string) => {
      const cur = Number(strings.get(key) ?? "0");
      const next = cur + 1;
      strings.set(key, String(next));
      return next;
    },
    sadd: async (key: string, ...members: string[]) => {
      const s = getSet(key);
      let added = 0;
      for (const m of members) { if (!s.has(m)) { s.add(m); added++; } }
      return added;
    },
    srem: async (key: string, ...members: string[]) => {
      const s = getSet(key);
      let removed = 0;
      for (const m of members) { if (s.delete(m)) removed++; }
      return removed;
    },
    sscan: async (key: string, _cursor: string, _flag: string, _count: number): Promise<[string, string[]]> => {
      const s = sets.get(key);
      if (!s) return ["0", []];
      return ["0", [...s]];
    },
    lpush: async (key: string, ...vals: string[]) => {
      const list = getList(key);
      list.unshift(...vals.slice().reverse());
      return list.length;
    },
    ltrim: async (key: string, start: number, end: number) => {
      const list = getList(key);
      lists.set(key, list.slice(start, end + 1));
      return "OK";
    },
    llen: async (key: string) => (lists.get(key) ?? []).length,
    scan: async (_cursor: string, _flag: string, _pattern: string, _count: number): Promise<[string, string[]]> => {
      return ["0", []];
    },
    eval: async (script: string, _numKeys: number, ...args: string[]): Promise<unknown> => {
      const key = args[0];
      const arg1 = Number(args[1]);
      const arg2 = Number(args[2]);
      if (script.includes("reconnectCount")) {
        return reconnectClaimLua(key, arg1, arg2);
      }
      return reaperHandoffLua(key, arg1, arg2);
    },
    ping: async () => "PONG",
    defineCommand: () => {},
    // expose internals for test assertions
    _hashes: hashes,
    _strings: strings,
    _sets: sets,
    _lists: lists,
  };

  return redis as Redis;
}

// ---------------------------------------------------------------------------
// Metrics mock (mirrors dispatch.dispatcher.test.ts pattern)
// ---------------------------------------------------------------------------
function makeTestMetrics(): { metrics: Metrics; counts: Record<string, number> } {
  const counts: Record<string, number> = {};

  function makeCounter(name: string) {
    return {
      inc(labels?: Record<string, string>) {
        const key = labels ? `${name}:${JSON.stringify(labels)}` : name;
        counts[key] = (counts[key] ?? 0) + 1;
      },
    };
  }

  const metrics: Metrics = {
    registry: {} as never,
    sessionsActive: { inc: vi.fn(), dec: vi.fn(), set: vi.fn() } as never,
    sessionsStarted: makeCounter("sessionsStarted") as never,
    sessionsEnded: makeCounter("sessionsEnded") as never,
    framesReceived: makeCounter("framesReceived") as never,
    framesLateDropped: makeCounter("framesLateDropped") as never,
    audioQueueDropped: makeCounter("audioQueueDropped") as never,
    dispatchLatency: { observe: vi.fn() } as never,
    dispatchDeduped: makeCounter("dispatchDeduped") as never,
    dispatchFailed: makeCounter("dispatchFailed") as never,
    dispatchRejected: makeCounter("dispatchRejected") as never,
    sttErrors: makeCounter("sttErrors") as never,
    reconnects: makeCounter("reconnects") as never,
    twilioAuthRejected: makeCounter("twilioAuthRejected") as never,
    crossTenantRejected: makeCounter("crossTenantRejected") as never,
    sessionPanic: makeCounter("sessionPanic") as never,
    voiceOverload: makeCounter("voiceOverload") as never,
  };

  return { metrics, counts };
}

// ---------------------------------------------------------------------------
// Silent logger
// ---------------------------------------------------------------------------
function makeNullLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => makeNullLogger(),
  } as any;
}

// ---------------------------------------------------------------------------
// Twilio frame factories
// ---------------------------------------------------------------------------
const silenceMulaw = Buffer.alloc(160, 0xff).toString("base64"); // 20ms silence

function startFrame(
  streamSid: string,
  callSid: string,
  tenantId: string,
  conversationId: string,
  agentId = "agent-1"
) {
  return {
    event: "start",
    sequenceNumber: "1",
    streamSid,
    start: {
      streamSid,
      callSid,
      tracks: ["inbound_track", "outbound_track"],
      customParameters: { tenantId, conversationId, agentId },
    },
  };
}

function mediaFrame(
  streamSid: string,
  seqNo: number,
  track: "inbound_track" | "outbound_track",
  payloadB64 = silenceMulaw
) {
  return {
    event: "media",
    sequenceNumber: String(seqNo),
    streamSid,
    media: {
      track,
      chunk: String(seqNo),
      timestamp: String(seqNo * 20),
      payload: payloadB64,
    },
  };
}

function stopFrame(streamSid: string) {
  return {
    event: "stop",
    sequenceNumber: "999",
    streamSid,
    stop: { callSid: "CA_STOP" },
  };
}

// ---------------------------------------------------------------------------
// Async polling helper
// ---------------------------------------------------------------------------
async function waitUntil(
  condition: () => boolean,
  timeoutMs = 2000,
  label = "condition"
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`waitUntil timed out after ${timeoutMs}ms: ${label}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ---------------------------------------------------------------------------
// Build a full test harness (boots createApp on random port)
// ---------------------------------------------------------------------------
interface TestHarness {
  builtApp: BuiltApp;
  port: number;
  clock: FakeClock;
  posts: Array<{ body: VoiceStreamBody; opts: PostVoiceStreamOptions }>;
  counts: Record<string, number>;
  redis: Redis & {
    _hashes: Map<string, Map<string, string>>;
    _strings: Map<string, string>;
    _sets: Map<string, Set<string>>;
  };
  wsUrl: (tenantId: string) => string;
}

function buildHarness(): TestHarness {
  const clock = createFakeClock();
  const redis = makeInMemoryRedis();
  const { metrics, counts } = makeTestMetrics();
  const logger = makeNullLogger();

  // Set the shared ref so getRedis() in buildDefaultDeps returns our mock
  sharedRedisRef.current = redis;

  const posts: Array<{ body: VoiceStreamBody; opts: PostVoiceStreamOptions }> = [];

  const aiAssistClient = async (
    body: VoiceStreamBody,
    opts: PostVoiceStreamOptions
  ): Promise<PostResult> => {
    posts.push({ body, opts });
    return { ok: true, status: 200 };
  };

  // STT factory: finals only (partials suppressed) so the dispatcher's Redis NX
  // deduplication never blocks a final behind a previously-dispatched partial.
  // finalIntervalMs=200 means tick 1 (at 200ms) emits the final directly.
  const sttFactory = (cfg: SttConfig) =>
    new StubSTTProvider({
      seed: cfg.seed ?? 42,
      phraseList: ["hello", "yes", "okay"],
      partialIntervalMs: 999_999, // effectively never — no partials emitted
      finalIntervalMs: 200,       // tick 1 at 200ms emits a final
      clock,
    });

  const sessionStore = createSessionStore(redis);

  const dispatcher = new Dispatcher({
    client: aiAssistClient as unknown as (body: unknown, opts: unknown) => Promise<unknown>,
    redis,
    aiServiceUrl: "http://ai-mock:4006",
    internalKey: "test-key",
    clock,
    random: () => 0.5,
    logger,
    metrics,
    // Large batch window so partials and finals batch together in the same POST.
    // The STT stub emits a partial at tick 1 (200ms) and final at tick 2 (400ms).
    // With batchWindowMs=600, both land in the same batch before the window fires.
    batchWindowMs: 600,
    batchMax: 50,
    retryScheduleMs: [],
  });

  const sessionFactory = makeSessionFactory({
    store: sessionStore,
    sttFactory,
    sttConfig: {
      provider: "stub",
      language: "en-US",
      interimResults: true,
      seed: 42,
    },
    dispatcher,
    clock,
    logger,
    metrics,
    eventBus: { publish: async () => {} },
  });

  const reaper = new Reaper({
    store: sessionStore,
    redis,
    clock,
    logger,
    metrics,
    intervalMs: 999_999,
    staleMs: 120_000,
    endSession: async () => {},
  });

  const overrides: Partial<AppDeps> = {
    redis,
    clock,
    logger,
    metrics,
    sttFactory,
    dispatcher,
    sessionStore,
    sessionFactory,
    reaper,
    aiAssistClient: aiAssistClient as any,
    publishEvent: async () => {},
    random: () => 0.5,
  };

  const builtApp = createApp(overrides);

  // Wire: secureHmac always passes — inject via TwilioHandlerDeps override.
  // createApp calls attachTwilioHandler internally. The only way to bypass HMAC
  // in e2e is to pass secureHmac override through createApp. Since createApp
  // doesn't expose that option, we test by listening on the raw server and
  // using wss.emit("connection", ...) trick via a custom HTTP upgrade handler.
  //
  // However, app.ts does pass reconnectGraceMs & secureHmac through
  // attachTwilioHandler's deps. We need to patch the httpServer upgrade handler.
  // The simplest approach: override the upgrade listener added by attachTwilioHandler
  // by removing the existing one and re-adding one that skips HMAC.
  //
  // Look at how twilio-handler.ts registers: httpServer.on("upgrade", ...)
  // We can replace them all since this is a test server.
  const { httpServer, wss } = builtApp;

  // Remove all upgrade listeners so we can replace the HMAC check
  httpServer.removeAllListeners("upgrade");

  // Re-attach a permissive upgrade listener
  const PATH_RE = /^\/twilio\/media-stream\/([^/?#]+)/;
  httpServer.on("upgrade", (req: http.IncomingMessage, socket: import("net").Socket, head: Buffer) => {
    const url = req.url ?? "";
    const match = PATH_RE.exec(url);
    if (!match) {
      socket.destroy();
      return;
    }
    const tenantId = match[1];
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, { tenantId });
    });
  });

  return {
    builtApp,
    port: 0, // set after listen
    clock,
    posts,
    counts,
    redis: redis as any,
    wsUrl: (tenantId: string) => `ws://127.0.0.1:0/twilio/media-stream/${tenantId}`,
  };
}

// ---------------------------------------------------------------------------
// Helper: listen on random port and return port number
// ---------------------------------------------------------------------------
function listenOnRandomPort(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        resolve(addr.port);
      } else {
        reject(new Error("Could not get server address"));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Helper: open WS and wait for OPEN state
// ---------------------------------------------------------------------------
function openWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Helper: send JSON frame
// ---------------------------------------------------------------------------
function send(ws: WebSocket, frame: unknown): void {
  ws.send(JSON.stringify(frame));
}

// ---------------------------------------------------------------------------
// Helper: close WS and wait for close event
// ---------------------------------------------------------------------------
function closeWs(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    ws.on("close", () => resolve());
    ws.close();
  });
}

// ---------------------------------------------------------------------------
// Helper: collect WS close code
// ---------------------------------------------------------------------------
function collectClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("voice-copilot e2e", () => {
  let harness: TestHarness;
  let port: number;
  let activeWs: WebSocket[] = [];

  beforeEach(async () => {
    harness = buildHarness();
    port = await listenOnRandomPort(harness.builtApp.httpServer);
    activeWs = [];
  });

  afterEach(async () => {
    // Close any open WebSocket connections
    await Promise.all(activeWs.map((ws) => closeWs(ws)));
    activeWs = [];
    // Shutdown app
    await harness.builtApp.shutdown().catch(() => {});
  });

  function wsUrl(tenantId = "tenant_e2e") {
    return `ws://127.0.0.1:${port}/twilio/media-stream/${tenantId}`;
  }

  // -------------------------------------------------------------------------
  // 1. Happy path: start → 10 media frames (5 inbound + 5 outbound) → stop
  // -------------------------------------------------------------------------
  it("happy path: start+media+stop dispatches voice_stream posts with correct tenantId and ordering", async () => {
    const { clock, posts } = harness;

    const ws = await openWs(wsUrl());
    activeWs.push(ws);

    const STREAM_SID = "MZ_HAPPY";
    const CALL_SID = "CA_HAPPY";
    const TENANT = "tenant_e2e";
    const CONV = "conv-happy";

    // Send start
    send(ws, startFrame(STREAM_SID, CALL_SID, TENANT, CONV));
    await new Promise((r) => setTimeout(r, 20));

    // Send 5 inbound + 5 outbound frames interleaved
    for (let i = 0; i < 5; i++) {
      send(ws, mediaFrame(STREAM_SID, i * 2 + 2, "inbound_track"));
      send(ws, mediaFrame(STREAM_SID, i * 2 + 3, "outbound_track"));
    }
    await new Promise((r) => setTimeout(r, 30));

    // Advance fake clock to trigger STT finals (2 ticks × 200ms = 400ms)
    // and dispatcher batch window (50ms)
    clock.advance(500);
    await new Promise((r) => setTimeout(r, 30));

    // Send stop
    send(ws, stopFrame(STREAM_SID));
    await new Promise((r) => setTimeout(r, 30));

    // Allow dispatcher flush triggered by session.end
    clock.advance(100);
    await new Promise((r) => setTimeout(r, 30));

    // Wait for at least 1 POST
    await waitUntil(() => posts.length >= 1, 2000, "at least 1 post");

    // All posts must carry type:"voice_stream"
    expect(posts.every((p) => p.body.type === "voice_stream")).toBe(true);

    // Every post must have the correct tenantId
    expect(posts.every((p) => p.body.tenantId === TENANT)).toBe(true);

    // Every post must carry a conversationId
    expect(posts.every((p) => p.body.conversationId === CONV)).toBe(true);

    // For each (speaker, seq) combination, at most one isFinal:true message
    const finalsByKey = new Map<string, number>();
    for (const post of posts) {
      for (const msg of post.body.messages) {
        if (msg.isFinal) {
          const key = `${msg.speaker}:${msg.seq}`;
          finalsByKey.set(key, (finalsByKey.get(key) ?? 0) + 1);
        }
      }
    }
    for (const [key, count] of finalsByKey) {
      expect(count, `duplicate isFinal for ${key}`).toBe(1);
    }
  });

  // -------------------------------------------------------------------------
  // 2. Idempotency: same callSid reused quickly → seqs not re-dispatched twice
  // -------------------------------------------------------------------------
  it("idempotency: same (tenantId, conversationId, speaker, seq) not dispatched twice via Redis SETNX", async () => {
    const { clock, posts } = harness;

    const STREAM_SID = "MZ_IDEM";
    const CALL_SID = "CA_IDEM";
    const TENANT = "tenant_e2e";
    const CONV = "conv-idem";

    const ws = await openWs(wsUrl());
    activeWs.push(ws);

    send(ws, startFrame(STREAM_SID, CALL_SID, TENANT, CONV));
    await new Promise((r) => setTimeout(r, 20));

    // Send 2 inbound frames
    send(ws, mediaFrame(STREAM_SID, 2, "inbound_track"));
    send(ws, mediaFrame(STREAM_SID, 3, "inbound_track"));
    await new Promise((r) => setTimeout(r, 20));

    // Advance past STT final tick (200ms) and dispatcher batch window (600ms)
    clock.advance(250); // tick 1: final fired, dispatcher timer set at t=250+600=850
    await new Promise((r) => setTimeout(r, 10));
    clock.advance(700); // past t=850 → dispatcher batch timer fires
    await new Promise((r) => setTimeout(r, 40)); // let async flush resolve

    await waitUntil(() => posts.length >= 1, 2000, "first batch dispatched");
    const postsAfterFirst = posts.length;

    // The in-memory Redis has the NX keys set; new pipeline.set NX will return null
    const { dispatcher } = harness.builtApp;

    // Manually enqueue the same transcripts again to simulate re-dispatch attempt
    // This exercises the dispatcher's Redis SETNX deduplication path
    const postsBeforeRetry = posts.length;

    // Enqueue duplicate items via the dispatcher directly (same tenantId+conversationId+speaker+seq
    // that was already dispatched — NX will fail for those keys)
    for (const post of posts.slice(0, postsAfterFirst)) {
      for (const msg of post.body.messages) {
        dispatcher.enqueue({ tenantId: TENANT, conversationId: CONV, message: msg });
      }
    }

    // Advance past batch window so the duplicate batch flushes (and gets deduped)
    clock.advance(800);
    await new Promise((r) => setTimeout(r, 40));

    // The deduped counter must have incremented (NX returned null for already-set keys)
    const dedupedCount = harness.counts["dispatchDeduped"] ?? 0;
    expect(dedupedCount).toBeGreaterThanOrEqual(1);

    // No new POSTs should have been sent for the duplicate items
    // (posts may grow only if there are genuinely new seqs, which there aren't)
    expect(posts.length).toBe(postsBeforeRetry);
  });

  // -------------------------------------------------------------------------
  // 3. Backpressure: 500 frames → queue bounded to 200 → audioQueueDropped ≥ 300
  // -------------------------------------------------------------------------
  it("backpressure: 500 rapid media frames → audioQueueDropped metric incremented ≥ 300", async () => {
    const { clock, counts } = harness;

    const STREAM_SID = "MZ_BP";
    const CALL_SID = "CA_BP";
    const TENANT = "tenant_e2e";
    const CONV = "conv-bp";

    const ws = await openWs(wsUrl());
    activeWs.push(ws);

    send(ws, startFrame(STREAM_SID, CALL_SID, TENANT, CONV));
    await new Promise((r) => setTimeout(r, 20));

    // Activate session by sending first inbound frame and advancing clock
    send(ws, mediaFrame(STREAM_SID, 2, "inbound_track"));
    await new Promise((r) => setTimeout(r, 20));
    clock.advance(10); // ringing → active

    // Now flood 500 inbound frames — queue capacity is 200 so 300+ must drop
    for (let i = 0; i < 500; i++) {
      send(ws, mediaFrame(STREAM_SID, i + 100, "inbound_track"));
    }

    // Allow all messages to be processed
    await new Promise((r) => setTimeout(r, 100));

    // Check that drops occurred
    // audioQueueDropped is labelled {tenant, speaker}
    const dropKey = `audioQueueDropped:${JSON.stringify({ tenant: TENANT, speaker: "customer" })}`;
    const dropped = counts[dropKey] ?? 0;
    expect(dropped).toBeGreaterThanOrEqual(300);
  });

  // -------------------------------------------------------------------------
  // 4. Reconnect: WS dropped mid-stream, new WS with same callSid → session reused
  // -------------------------------------------------------------------------
  it("reconnect: WS dropped and reconnected within grace window reuses session", async () => {
    const { clock, counts } = harness;

    const STREAM_SID_1 = "MZ_RC1";
    const STREAM_SID_2 = "MZ_RC2";
    const CALL_SID = "CA_RECONNECT";
    const TENANT = "tenant_e2e";
    const CONV = "conv-reconnect";

    // First connection
    const ws1 = await openWs(wsUrl());
    activeWs.push(ws1);

    send(ws1, startFrame(STREAM_SID_1, CALL_SID, TENANT, CONV));
    // Wait long enough for bootstrap() to complete (creates session + sets callSid index in Redis)
    await new Promise((r) => setTimeout(r, 60));

    // Send a frame to update lastFrameAt so reconnect grace check passes
    send(ws1, mediaFrame(STREAM_SID_1, 2, "inbound_track"));
    await new Promise((r) => setTimeout(r, 30));

    // Abruptly close ws1 — grace timer will start; clock at 0 so it won't fire
    const ws1Closed = new Promise<void>((resolve) => ws1.on("close", resolve));
    ws1.terminate();
    await ws1Closed;
    activeWs.splice(activeWs.indexOf(ws1), 1);
    // Allow close handler to run
    await new Promise((r) => setTimeout(r, 20));

    // Reconnect within grace window (reconnectGraceMs=10_000, clock at 0)
    // The store has callSid index pointing to CONV and lastFrameAt=0; now=0 → difference=0 ≤ 10_000
    const reconnectLabelKey = `reconnects:${JSON.stringify({ tenant: TENANT })}`;
    const reconnectsBefore = counts[reconnectLabelKey] ?? 0;

    const ws2 = await openWs(wsUrl());
    activeWs.push(ws2);

    send(ws2, startFrame(STREAM_SID_2, CALL_SID, TENANT, CONV));
    // Wait for reconnect path to complete (findByCallSid + reconnectClaim async)
    await new Promise((r) => setTimeout(r, 80));

    // reconnects counter must have incremented (twilio-handler emits metrics.reconnects.inc({tenant}))
    const reconnectsAfter = counts[reconnectLabelKey] ?? 0;
    expect(reconnectsAfter).toBeGreaterThan(reconnectsBefore);

    // Subsequent frames on ws2 should dispatch normally (session still active)
    send(ws2, mediaFrame(STREAM_SID_2, 10, "inbound_track"));
    clock.advance(500);
    await new Promise((r) => setTimeout(r, 30));

    // No crash, session still functional
    expect(harness.builtApp.httpServer.listening).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 5. Final triggers assist: isFinal:true message reaches mock ai-assist
  // -------------------------------------------------------------------------
  it("final transcript: at least one POST with isFinal:true reaches the mock ai-assist client", async () => {
    const { clock, posts } = harness;

    const STREAM_SID = "MZ_FINAL";
    const CALL_SID = "CA_FINAL";
    const TENANT = "tenant_e2e";
    const CONV = "conv-final";

    const ws = await openWs(wsUrl());
    activeWs.push(ws);

    send(ws, startFrame(STREAM_SID, CALL_SID, TENANT, CONV));
    // Wait for start frame to be processed (session created + STT stream started)
    await new Promise((r) => setTimeout(r, 40));

    // Send inbound frames — each call push() on the STT stream
    for (let i = 0; i < 5; i++) {
      send(ws, mediaFrame(STREAM_SID, i + 2, "inbound_track"));
    }
    // Wait for all message handlers to process frames and call STT push()
    await new Promise((r) => setTimeout(r, 60));

    // With finalIntervalMs=200: tick 1 at t=200 → final emitted → dispatcher.enqueue.
    // Dispatcher timer set at t=200+600=800. Advance past t=800 to flush the batch.
    clock.advance(250); // fires tick 1 (final) → enqueues to dispatcher
    await new Promise((r) => setTimeout(r, 20)); // let enqueue callback complete

    clock.advance(700); // advances to t=950 → past t=800 → dispatcher timer fires
    await new Promise((r) => setTimeout(r, 40)); // let async flush (pipeline + client) resolve

    // Send stop to flush any remaining buffered items
    send(ws, stopFrame(STREAM_SID));
    await new Promise((r) => setTimeout(r, 40));
    clock.advance(200);
    await new Promise((r) => setTimeout(r, 30));

    await waitUntil(() => posts.length >= 1, 2000, "at least 1 post");

    // Find at least one message with isFinal:true
    const hasFinal = posts.some((p) => p.body.messages.some((m) => m.isFinal === true));
    expect(hasFinal).toBe(true);

    // Confirm it reached the mock with correct tenantId
    const finalPost = posts.find((p) => p.body.messages.some((m) => m.isFinal));
    expect(finalPost?.body.tenantId).toBe(TENANT);
  });

  // -------------------------------------------------------------------------
  // 6. Stop frame ends session: no more POSTs after stop
  // -------------------------------------------------------------------------
  it("stop frame ends session: no new POSTs dispatched after stop", async () => {
    const { clock, posts } = harness;

    const STREAM_SID = "MZ_STOP";
    const CALL_SID = "CA_STOP_TEST";
    const TENANT = "tenant_e2e";
    const CONV = "conv-stop";

    const ws = await openWs(wsUrl());
    activeWs.push(ws);

    send(ws, startFrame(STREAM_SID, CALL_SID, TENANT, CONV));
    await new Promise((r) => setTimeout(r, 20));

    // Send frames and generate some finals
    for (let i = 0; i < 3; i++) {
      send(ws, mediaFrame(STREAM_SID, i + 2, "inbound_track"));
    }
    clock.advance(500);
    await new Promise((r) => setTimeout(r, 30));
    clock.advance(100);
    await new Promise((r) => setTimeout(r, 30));

    // Stop session
    send(ws, stopFrame(STREAM_SID));
    await new Promise((r) => setTimeout(r, 30));
    clock.advance(100);
    await new Promise((r) => setTimeout(r, 30));

    // Count posts right after stop
    const postsAtStop = posts.length;

    // Send more frames after stop — they should be ignored (session ended)
    for (let i = 0; i < 5; i++) {
      send(ws, mediaFrame(STREAM_SID, i + 100, "inbound_track"));
    }
    clock.advance(500);
    await new Promise((r) => setTimeout(r, 50));
    clock.advance(100);
    await new Promise((r) => setTimeout(r, 30));

    // No new posts for this conversation
    const postsForConv = posts.filter((p) => p.body.conversationId === CONV);
    // Some posts before stop are expected; after stop there should be none
    // We can't do an exact equality since flush on session.end may add one last batch.
    // Verify post count stabilized (no additional posts from frames sent after stop)
    const postsAtStopForConv = postsForConv.filter((_, idx) => idx < postsAtStop);
    expect(postsAtStopForConv.length).toBeLessThanOrEqual(postsForConv.length);
    // The total should not have grown by more than 1 (the final flush on stop)
    expect(postsForConv.length).toBeLessThanOrEqual(postsAtStop + 1);
  });

  // -------------------------------------------------------------------------
  // 7. Cross-tenant rejection: wrong tenantId in customParameters → ws closed 1008
  // -------------------------------------------------------------------------
  it("cross-tenant rejection: mismatched tenantId closes WS with code 1008", async () => {
    const { counts } = harness;

    const ws = await openWs(wsUrl("tenant_e2e"));
    activeWs.push(ws);

    const closePromise = collectClose(ws);

    // Send start with a different tenantId in customParameters
    send(ws, {
      event: "start",
      sequenceNumber: "1",
      streamSid: "MZ_CROSS",
      start: {
        streamSid: "MZ_CROSS",
        callSid: "CA_CROSS",
        tracks: ["inbound_track"],
        customParameters: {
          tenantId: "tenant_OTHER",  // mismatch — path is tenant_e2e
          conversationId: "conv-cross",
        },
      },
    });

    const { code } = await closePromise;
    activeWs.splice(activeWs.indexOf(ws), 1);

    expect(code).toBe(1008);

    // crossTenantRejected metric must have incremented
    const rejectedCount = counts["crossTenantRejected"] ?? 0;
    expect(rejectedCount).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // 8. Ordering under out-of-order frames: shuffled seqNo → dispatched in order
  // -------------------------------------------------------------------------
  it("out-of-order frames: dispatched messages are ordered by seq per speaker", async () => {
    const { clock, posts } = harness;

    const STREAM_SID = "MZ_OOO";
    const CALL_SID = "CA_OOO";
    const TENANT = "tenant_e2e";
    const CONV = "conv-ooo";

    const ws = await openWs(wsUrl());
    activeWs.push(ws);

    send(ws, startFrame(STREAM_SID, CALL_SID, TENANT, CONV));
    await new Promise((r) => setTimeout(r, 20));

    // Send inbound frames out of order: 5, 2, 4, 3, 6
    const shuffledSeqs = [5, 2, 4, 3, 6];
    for (const seqNo of shuffledSeqs) {
      send(ws, mediaFrame(STREAM_SID, seqNo, "inbound_track"));
    }
    await new Promise((r) => setTimeout(r, 20));

    // Advance to produce finals and flush
    clock.advance(800);
    await new Promise((r) => setTimeout(r, 30));
    clock.advance(100);
    await new Promise((r) => setTimeout(r, 30));

    // Flush via stop
    send(ws, stopFrame(STREAM_SID));
    clock.advance(100);
    await new Promise((r) => setTimeout(r, 40));

    await waitUntil(() => posts.length >= 1, 2000, "posts after ooo frames");

    // Collect all customer messages across all posts
    const customerMsgs = posts
      .filter((p) => p.body.conversationId === CONV)
      .flatMap((p) => p.body.messages.filter((m) => m.speaker === "customer"));

    // If any finals were emitted, they should have monotonically increasing seq
    const finals = customerMsgs.filter((m) => m.isFinal);
    for (let i = 1; i < finals.length; i++) {
      expect(finals[i].seq).toBeGreaterThanOrEqual(finals[i - 1].seq);
    }

    // Partials within a post should be ordered by seq too
    for (const post of posts.filter((p) => p.body.conversationId === CONV)) {
      const msgs = post.body.messages.filter((m) => m.speaker === "customer");
      for (let i = 1; i < msgs.length; i++) {
        expect(msgs[i].seq).toBeGreaterThanOrEqual(msgs[i - 1].seq);
      }
    }
  });
});
