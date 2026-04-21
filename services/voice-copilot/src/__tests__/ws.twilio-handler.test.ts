import { describe, it, expect, vi, beforeEach } from "vitest";
import * as http from "http";
import { EventEmitter } from "events";
import { WebSocketServer } from "ws";
import { attachTwilioHandler, type TwilioHandlerDeps } from "../ws/twilio-handler";
import { createFakeClock } from "../lib/clock";
import type { SessionRecord } from "../session/session-store";
import type { Session } from "../session/session";

// ---------------------------------------------------------------------------
// Helpers / mocks
// ---------------------------------------------------------------------------

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  } as any;
}

function makeMetrics() {
  const counter = () => ({ inc: vi.fn() });
  const gauge = () => ({ inc: vi.fn(), dec: vi.fn() });
  return {
    sessionsActive: gauge(),
    sessionsStarted: counter(),
    sessionsEnded: counter(),
    framesReceived: counter(),
    framesLateDropped: counter(),
    audioQueueDropped: counter(),
    dispatchLatency: { observe: vi.fn() },
    dispatchDeduped: counter(),
    dispatchFailed: counter(),
    dispatchRejected: counter(),
    sttErrors: counter(),
    reconnects: counter(),
    twilioAuthRejected: counter(),
    crossTenantRejected: counter(),
    sessionPanic: counter(),
    voiceOverload: counter(),
    registry: {} as any,
  } as any;
}

function makeStore() {
  return {
    findByCallSid: vi.fn().mockResolvedValue(null),
    reconnectClaim: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null),
    updateState: vi.fn().mockResolvedValue(undefined),
    refreshTtl: vi.fn().mockResolvedValue(undefined),
    incrField: vi.fn().mockResolvedValue(undefined),
    touchLastFrame: vi.fn().mockResolvedValue(undefined),
    setCallSidIndex: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    nextSeq: vi.fn().mockResolvedValue(1),
    claimIdempotency: vi.fn().mockResolvedValue(true),
    reaperHandoff: vi.fn().mockResolvedValue(false),
    addToReaperSet: vi.fn().mockResolvedValue(undefined),
    removeFromReaperSet: vi.fn().mockResolvedValue(undefined),
    scanReaperSet: vi.fn().mockResolvedValue({ cursor: "0", members: [] }),
  };
}

function makeSession(): Session {
  return {
    tenantId: "tenant-1",
    conversationId: "conv-abc",
    callSid: "CA999",
    startedAt: 0,
    state: "ringing",
    bootstrap: vi.fn().mockResolvedValue(undefined),
    handleMediaFrame: vi.fn().mockResolvedValue(undefined),
    handleStop: vi.fn().mockResolvedValue(undefined),
    handleWsClose: vi.fn().mockResolvedValue(undefined),
    resumeFromReconnect: vi.fn().mockResolvedValue(undefined),
    end: vi.fn().mockResolvedValue(undefined),
  } as unknown as Session;
}

/** Build a minimal fake HTTP request for upgrade testing */
function makeUpgradeReq(url: string, sig?: string, host = "example.com"): http.IncomingMessage {
  const req = new EventEmitter() as http.IncomingMessage;
  req.url = url;
  req.method = "GET";
  req.headers = {
    host,
    "x-forwarded-proto": "https",
    "x-twilio-signature": sig,
  };
  return req;
}

/** Minimal fake socket that records destroy/write calls */
function makeSocket() {
  return {
    destroyed: false,
    destroy: vi.fn(function (this: any) { this.destroyed = true; }),
    write: vi.fn(),
    on: vi.fn(),
  } as any;
}

/** Build a fake WS client that behaves like an EventEmitter */
function makeFakeWs(): EventEmitter & { close: ReturnType<typeof vi.fn>; readyState: number } {
  const ws = new EventEmitter() as any;
  ws.close = vi.fn();
  ws.readyState = 1; // OPEN
  return ws;
}

function buildDeps(overrides: Partial<TwilioHandlerDeps> = {}): {
  deps: TwilioHandlerDeps;
  wss: WebSocketServer;
  store: ReturnType<typeof makeStore>;
  metrics: ReturnType<typeof makeMetrics>;
  clock: ReturnType<typeof createFakeClock>;
  sessionFactory: ReturnType<typeof vi.fn>;
  session: Session;
} {
  const wss = new WebSocketServer({ noServer: true });
  const store = makeStore();
  const metrics = makeMetrics();
  const clock = createFakeClock();
  const session = makeSession();
  const sessionFactory = vi.fn().mockReturnValue(session);

  const deps: TwilioHandlerDeps = {
    wss,
    store,
    sessionFactory,
    clock,
    logger: makeLogger(),
    metrics,
    maxConcurrent: 10,
    reconnectGraceMs: 5000,
    getTwilioAuthToken: vi.fn().mockResolvedValue("secret-token"),
    // Accept all signatures by default
    secureHmac: vi.fn().mockReturnValue(true),
    ...overrides,
  };

  return { deps, wss, store, metrics, clock, sessionFactory, session };
}

/** Simulate an upgrade event on the httpServer with a fake socket */
async function triggerUpgrade(
  httpServer: EventEmitter,
  url: string,
  sig?: string,
  extraHeaders?: Record<string, string>
) {
  const req = makeUpgradeReq(url, sig);
  if (extraHeaders) {
    Object.assign(req.headers, extraHeaders);
  }
  const socket = makeSocket();
  const head = Buffer.alloc(0);
  httpServer.emit("upgrade", req, socket, head);
  // Allow async handlers to settle
  await new Promise((r) => setImmediate(r));
  return { req, socket };
}

/** Simulate a WS connection event (bypass the upgrade flow) */
function triggerConnection(
  wss: WebSocketServer,
  ws: ReturnType<typeof makeFakeWs>,
  tenantId: string,
  req?: http.IncomingMessage
) {
  const r = req ?? makeUpgradeReq(`/twilio/media-stream/${tenantId}`);
  wss.emit("connection", ws, r, { tenantId });
}

function sendFrame(ws: ReturnType<typeof makeFakeWs>, frame: unknown) {
  ws.emit("message", Buffer.from(JSON.stringify(frame)));
}

// ---------------------------------------------------------------------------
// Tests: upgrade path
// ---------------------------------------------------------------------------

describe("attachTwilioHandler — upgrade path", () => {
  it("accepts a valid upgrade and calls handleUpgrade", async () => {
    const httpServer = new EventEmitter() as http.Server;
    const { deps, wss } = buildDeps();
    // Mock handleUpgrade so it doesn't attempt a real WebSocket handshake with a fake socket
    const handleUpgradeSpy = vi.spyOn(wss, "handleUpgrade").mockImplementation(() => {});

    attachTwilioHandler(httpServer, deps);
    await triggerUpgrade(httpServer, "/twilio/media-stream/tenant-1");

    expect(handleUpgradeSpy).toHaveBeenCalledOnce();
  });

  it("destroys socket when path does not match", async () => {
    const httpServer = new EventEmitter() as http.Server;
    const { deps } = buildDeps();
    attachTwilioHandler(httpServer, deps);

    const { socket } = await triggerUpgrade(httpServer, "/some/other/path");
    expect(socket.destroy).toHaveBeenCalled();
  });

  it("destroys socket and increments twilioAuthRejected when token lookup fails", async () => {
    const httpServer = new EventEmitter() as http.Server;
    const { deps, metrics } = buildDeps({
      getTwilioAuthToken: vi.fn().mockRejectedValue(new Error("secret not found")),
    });
    attachTwilioHandler(httpServer, deps);

    const { socket } = await triggerUpgrade(httpServer, "/twilio/media-stream/tenant-1");
    expect(socket.destroy).toHaveBeenCalled();
    expect(metrics.twilioAuthRejected.inc).toHaveBeenCalled();
  });

  it("rejects with 401 and increments twilioAuthRejected on signature mismatch", async () => {
    const httpServer = new EventEmitter() as http.Server;
    const { deps, metrics } = buildDeps({
      secureHmac: vi.fn().mockReturnValue(false),
    });
    attachTwilioHandler(httpServer, deps);

    const { socket } = await triggerUpgrade(httpServer, "/twilio/media-stream/tenant-1", "bad-sig");
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining("401"));
    expect(socket.destroy).toHaveBeenCalled();
    expect(metrics.twilioAuthRejected.inc).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: connection behavior
// ---------------------------------------------------------------------------

describe("attachTwilioHandler — connection handling", () => {
  it("closes with 1013 and increments voiceOverload when at capacity", async () => {
    const httpServer = new EventEmitter() as http.Server;
    const { deps, wss, metrics } = buildDeps({ maxConcurrent: 0 });
    attachTwilioHandler(httpServer, deps);

    const ws = makeFakeWs();
    triggerConnection(wss, ws, "tenant-1");
    await new Promise((r) => setImmediate(r));

    expect(ws.close).toHaveBeenCalledWith(1013, "overload");
    expect(metrics.voiceOverload.inc).toHaveBeenCalled();
  });

  it("closes with 1008 cross_tenant on customParameters tenantId mismatch", async () => {
    const httpServer = new EventEmitter() as http.Server;
    const { deps, wss, metrics } = buildDeps();
    attachTwilioHandler(httpServer, deps);

    const ws = makeFakeWs();
    triggerConnection(wss, ws, "tenant-1");
    await new Promise((r) => setImmediate(r));

    sendFrame(ws, {
      event: "start",
      sequenceNumber: "1",
      streamSid: "MZ123",
      start: {
        streamSid: "MZ123",
        callSid: "CA999",
        tracks: ["inbound_track"],
        customParameters: {
          tenantId: "tenant-OTHER",   // mismatch
          conversationId: "conv-abc",
        },
      },
    });
    await new Promise((r) => setImmediate(r));

    expect(ws.close).toHaveBeenCalledWith(1008, "cross_tenant");
    expect(metrics.crossTenantRejected.inc).toHaveBeenCalled();
  });

  it("creates a Session via sessionFactory on start frame", async () => {
    const httpServer = new EventEmitter() as http.Server;
    const { deps, wss, sessionFactory, session } = buildDeps();
    attachTwilioHandler(httpServer, deps);

    const ws = makeFakeWs();
    triggerConnection(wss, ws, "tenant-1");
    await new Promise((r) => setImmediate(r));

    sendFrame(ws, {
      event: "start",
      sequenceNumber: "1",
      streamSid: "MZ123",
      start: {
        streamSid: "MZ123",
        callSid: "CA999",
        tracks: ["inbound_track"],
        customParameters: { tenantId: "tenant-1", conversationId: "conv-abc" },
      },
    });
    await new Promise((r) => setImmediate(r));

    expect(sessionFactory).toHaveBeenCalledOnce();
    const record: SessionRecord = sessionFactory.mock.calls[0][0];
    expect(record.tenantId).toBe("tenant-1");
    expect(record.conversationId).toBe("conv-abc");
    expect(record.callSid).toBe("CA999");
    expect(session.bootstrap).toHaveBeenCalledOnce();
  });

  it("forwards media frames to session.handleMediaFrame", async () => {
    const httpServer = new EventEmitter() as http.Server;
    const { deps, wss, session } = buildDeps();
    attachTwilioHandler(httpServer, deps);

    const ws = makeFakeWs();
    triggerConnection(wss, ws, "tenant-1");
    await new Promise((r) => setImmediate(r));

    // First send start to create session
    sendFrame(ws, {
      event: "start",
      sequenceNumber: "1",
      streamSid: "MZ123",
      start: {
        streamSid: "MZ123",
        callSid: "CA999",
        tracks: ["inbound_track"],
        customParameters: { tenantId: "tenant-1", conversationId: "conv-abc" },
      },
    });
    await new Promise((r) => setImmediate(r));

    // Send media frame
    sendFrame(ws, {
      event: "media",
      sequenceNumber: "2",
      streamSid: "MZ123",
      media: { track: "inbound_track", chunk: "1", timestamp: "500", payload: "AAAA" },
    });
    await new Promise((r) => setImmediate(r));

    expect(session.handleMediaFrame).toHaveBeenCalledOnce();
  });

  it("calls session.handleStop on stop frame", async () => {
    const httpServer = new EventEmitter() as http.Server;
    const { deps, wss, session } = buildDeps();
    attachTwilioHandler(httpServer, deps);

    const ws = makeFakeWs();
    triggerConnection(wss, ws, "tenant-1");
    await new Promise((r) => setImmediate(r));

    // Start session
    sendFrame(ws, {
      event: "start",
      sequenceNumber: "1",
      streamSid: "MZ123",
      start: {
        streamSid: "MZ123",
        callSid: "CA999",
        tracks: [],
        customParameters: { tenantId: "tenant-1", conversationId: "conv-abc" },
      },
    });
    await new Promise((r) => setImmediate(r));

    // Stop
    sendFrame(ws, {
      event: "stop",
      sequenceNumber: "5",
      streamSid: "MZ123",
      stop: { accountSid: "AC000", callSid: "CA999" },
    });
    await new Promise((r) => setImmediate(r));

    expect(session.handleStop).toHaveBeenCalledOnce();
  });

  it("schedules grace timer on ws close and calls session.end after grace ms", async () => {
    const httpServer = new EventEmitter() as http.Server;
    const { deps, wss, session, clock } = buildDeps();
    attachTwilioHandler(httpServer, deps);

    const ws = makeFakeWs();
    triggerConnection(wss, ws, "tenant-1");
    await new Promise((r) => setImmediate(r));

    // Start session
    sendFrame(ws, {
      event: "start",
      sequenceNumber: "1",
      streamSid: "MZ123",
      start: {
        streamSid: "MZ123",
        callSid: "CA999",
        tracks: [],
        customParameters: { tenantId: "tenant-1", conversationId: "conv-abc" },
      },
    });
    await new Promise((r) => setImmediate(r));

    // Simulate ws close
    ws.emit("close");
    await new Promise((r) => setImmediate(r));

    // session.end not called yet
    expect(session.end).not.toHaveBeenCalled();

    // Advance clock past grace period
    clock.advance(5000);
    await new Promise((r) => setImmediate(r));

    expect(session.end).toHaveBeenCalledWith("ws_closed");
  });

  it("reuses existing session on reconnect within grace window", async () => {
    const httpServer = new EventEmitter() as http.Server;
    const existingConvId = "conv-abc";
    const existingRecord: SessionRecord = {
      tenantId: "tenant-1",
      conversationId: existingConvId,
      callSid: "CA999",
      streamSid: "MZ-OLD",
      state: "active",
      startedAt: 0,
      lastFrameAt: 100,
      reconnectCount: 0,
      framesReceived: 5,
      framesDropped: 0,
      transcriptsEmitted: 0,
    };

    const store = makeStore();
    store.findByCallSid.mockResolvedValue(existingConvId);
    store.reconnectClaim.mockResolvedValue(existingRecord);

    const session = makeSession();
    const sessionFactory = vi.fn().mockReturnValue(session);

    const { deps, wss, metrics } = buildDeps({ store, sessionFactory });
    attachTwilioHandler(httpServer, deps);

    // First connection — creates session and registers in liveSessionMap
    const ws1 = makeFakeWs();
    triggerConnection(wss, ws1, "tenant-1");
    await new Promise((r) => setImmediate(r));

    sendFrame(ws1, {
      event: "start",
      sequenceNumber: "1",
      streamSid: "MZ-OLD",
      start: {
        streamSid: "MZ-OLD",
        callSid: "CA999",
        tracks: [],
        customParameters: { tenantId: "tenant-1", conversationId: existingConvId },
      },
    });
    await new Promise((r) => setImmediate(r));
    // First connection: store had no existing session initially; now registered
    // Reset so second call simulates reconnect
    store.findByCallSid.mockResolvedValue(existingConvId);
    store.reconnectClaim.mockResolvedValue(existingRecord);

    // Second connection reconnect (same callSid)
    const ws2 = makeFakeWs();
    triggerConnection(wss, ws2, "tenant-1");
    await new Promise((r) => setImmediate(r));

    sendFrame(ws2, {
      event: "start",
      sequenceNumber: "2",
      streamSid: "MZ-NEW",
      start: {
        streamSid: "MZ-NEW",
        callSid: "CA999",
        tracks: [],
        customParameters: { tenantId: "tenant-1", conversationId: existingConvId },
      },
    });
    await new Promise((r) => setImmediate(r));

    // resumeFromReconnect called; sessionFactory NOT called a second time for the same callSid
    expect(session.resumeFromReconnect).toHaveBeenCalled();
    // metrics.reconnects incremented
    expect(metrics.reconnects.inc).toHaveBeenCalled();
  });

  it("drops a malformed (non-JSON) frame without crashing", async () => {
    const httpServer = new EventEmitter() as http.Server;
    const { deps, wss } = buildDeps();
    attachTwilioHandler(httpServer, deps);

    const ws = makeFakeWs();
    triggerConnection(wss, ws, "tenant-1");
    await new Promise((r) => setImmediate(r));

    // Send raw non-JSON
    ws.emit("message", Buffer.from("not-json-at-all"));
    await new Promise((r) => setImmediate(r));

    // ws should still be open
    expect(ws.close).not.toHaveBeenCalled();
  });
});
