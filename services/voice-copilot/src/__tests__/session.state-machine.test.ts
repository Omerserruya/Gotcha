import { describe, it, expect, vi, beforeEach } from "vitest";
import { Session, makeSessionFactory, SESSION_TRANSITIONS } from "../session/session";
import type { SessionDeps, MediaFrameParsed } from "../session/session";
import type { SessionRecord, SessionStore, SessionState } from "../session/session-store";
import { InvalidStateTransition } from "../lib/errors";
import { createFakeClock } from "../lib/clock";
import type { Metrics } from "../metrics/metrics";
import type { Dispatcher } from "../dispatch/dispatcher";
import type { SttStream, SttError, Transcript } from "../stt/provider";

// ---------------------------------------------------------------------------
// Minimal mocks
// ---------------------------------------------------------------------------

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    tenantId: "t1",
    conversationId: "c1",
    callSid: "CA123",
    streamSid: "SS123",
    state: "ringing",
    startedAt: 0,
    lastFrameAt: 0,
    reconnectCount: 0,
    framesReceived: 0,
    framesDropped: 0,
    transcriptsEmitted: 0,
    ...overrides,
  };
}

function makeMockStore(): SessionStore {
  return {
    create: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null),
    updateState: vi.fn().mockResolvedValue(undefined),
    refreshTtl: vi.fn().mockResolvedValue(undefined),
    incrField: vi.fn().mockResolvedValue(undefined),
    touchLastFrame: vi.fn().mockResolvedValue(undefined),
    findByCallSid: vi.fn().mockResolvedValue(null),
    setCallSidIndex: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    nextSeq: vi.fn().mockResolvedValue(1),
    claimIdempotency: vi.fn().mockResolvedValue(true),
    reconnectClaim: vi.fn().mockResolvedValue(null),
    reaperHandoff: vi.fn().mockResolvedValue(false),
    addToReaperSet: vi.fn().mockResolvedValue(undefined),
    removeFromReaperSet: vi.fn().mockResolvedValue(undefined),
    scanReaperSet: vi.fn().mockResolvedValue({ cursor: "0", members: [] }),
  };
}

function makeMockMetrics(): Metrics {
  const counter = () => ({ inc: vi.fn() });
  const gauge = () => ({ inc: vi.fn(), dec: vi.fn(), set: vi.fn() });
  const histogram = () => ({ observe: vi.fn() });
  return {
    registry: {} as any,
    sessionsActive: gauge() as any,
    sessionsStarted: counter() as any,
    sessionsEnded: counter() as any,
    framesReceived: counter() as any,
    framesLateDropped: counter() as any,
    audioQueueDropped: counter() as any,
    dispatchLatency: histogram() as any,
    dispatchDeduped: counter() as any,
    dispatchFailed: counter() as any,
    dispatchRejected: counter() as any,
    sttErrors: counter() as any,
    reconnects: counter() as any,
    twilioAuthRejected: counter() as any,
    crossTenantRejected: counter() as any,
    sessionPanic: counter() as any,
    voiceOverload: counter() as any,
  };
}

function makeMockSttStream(): SttStream & { _emitError: (e: SttError) => void } {
  const listeners: Record<string, Function[]> = {};
  return {
    push: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    on: vi.fn().mockImplementation((event: string, cb: Function) => {
      listeners[event] = listeners[event] ?? [];
      listeners[event].push(cb);
    }),
    _emitError: (e: SttError) => {
      (listeners["error"] ?? []).forEach((cb) => cb(e));
    },
  };
}

function makeDeps(overrides: Partial<SessionDeps> = {}): SessionDeps {
  const clock = createFakeClock();
  const sttStream = makeMockSttStream();
  const store = makeMockStore();
  const metrics = makeMockMetrics();
  const dispatcher: Dispatcher = {
    enqueue: vi.fn(),
    flushSession: vi.fn().mockResolvedValue(undefined),
    circuitState: vi.fn().mockReturnValue("closed"),
  } as any;

  return {
    record: makeRecord(),
    store,
    sttFactory: vi.fn().mockReturnValue({ start: vi.fn().mockResolvedValue(sttStream) }),
    sttConfig: { provider: "stub", language: "en-US", interimResults: false },
    dispatcher,
    clock,
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as any,
    metrics,
    eventBus: { publish: vi.fn().mockResolvedValue(undefined) },
    reconnectGraceMs: 100,
    ...overrides,
  };
}

function makeMediaFrame(seq = 1): MediaFrameParsed {
  // 1 byte of silence mulaw (0xFF = 0)
  const payload = Buffer.from([0xFF]).toString("base64");
  return {
    sequenceNumber: String(seq),
    media: {
      track: "inbound_track",
      payload,
      timestamp: "0",
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Session state machine", () => {
  it("ringing → active on first handleMediaFrame", async () => {
    const deps = makeDeps();
    const session = new Session(deps);
    await session.bootstrap();

    expect(session.state).toBe("ringing");
    await session.handleMediaFrame(makeMediaFrame(1));
    expect(session.state).toBe("active");
  });

  it("ringing → ended on handleStop (no media yet)", async () => {
    const deps = makeDeps();
    const session = new Session(deps);
    await session.bootstrap();

    expect(session.state).toBe("ringing");
    await session.handleStop();
    expect(session.state).toBe("ended");
  });

  it("active → ended on handleStop", async () => {
    const deps = makeDeps();
    const session = new Session(deps);
    await session.bootstrap();
    await session.handleMediaFrame(makeMediaFrame(1));
    expect(session.state).toBe("active");

    await session.handleStop();
    expect(session.state).toBe("ended");
  });

  it("InvalidStateTransition: ended → any subsequent handleMediaFrame is guarded", async () => {
    const deps = makeDeps();
    const session = new Session(deps);
    await session.bootstrap();
    await session.handleStop(); // → ended

    // handleMediaFrame checks state === "ended" and calls end("panic") internally
    // but due to error boundary it doesn't throw - session stays ended
    await session.handleMediaFrame(makeMediaFrame(2));
    expect(session.state).toBe("ended");
  });

  it("SESSION_TRANSITIONS: ended state has no allowed transitions", () => {
    expect(SESSION_TRANSITIONS.ended).toHaveLength(0);
  });

  it("reconnect cancels grace timer and increments reconnects metric", async () => {
    const deps = makeDeps();
    const session = new Session(deps);
    await session.bootstrap();
    await session.handleMediaFrame(makeMediaFrame(1)); // → active

    // simulate WS close
    await session.handleWsClose();
    expect(session.state).toBe("active"); // not yet ended (within grace)

    // reconnect before grace expires
    await session.resumeFromReconnect();
    expect(deps.metrics.reconnects.inc).toHaveBeenCalledWith({ tenant: "t1" });

    // advance past grace - session should NOT end since grace was cancelled
    (deps.clock as any).advance(200);
    expect(session.state).toBe("active");
  });

  it("reaper-ended session: subsequent end() call is idempotent", async () => {
    const deps = makeDeps();
    const session = new Session(deps);
    await session.bootstrap();
    await session.handleMediaFrame(makeMediaFrame(1));

    await session.end("reaper");
    expect(session.state).toBe("ended");

    // Second call should be no-op (endCalled guard)
    await session.end("reaper");
    expect(session.state).toBe("ended");
    // sessionsEnded should only be called once
    expect((deps.metrics.sessionsEnded.inc as any).mock.calls.length).toBe(1);
  });

  it("stt_overload transition after 3 RATE_LIMIT errors in 30s window", async () => {
    const clock = createFakeClock();
    const sttStream = makeMockSttStream();
    const deps = makeDeps({
      clock,
      sttFactory: vi.fn().mockReturnValue({ start: vi.fn().mockResolvedValue(sttStream) }),
    });
    const session = new Session(deps);
    await session.bootstrap();
    await session.handleMediaFrame(makeMediaFrame(1)); // → active, starts STT

    const rateError: SttError = { code: "RATE_LIMIT", message: "rate limit", retryable: true };

    // First error
    sttStream._emitError(rateError);
    expect(session.state).toBe("active");

    // Second error
    sttStream._emitError(rateError);
    expect(session.state).toBe("active");

    // Third error - triggers stt_overload
    sttStream._emitError(rateError);
    // The end("stt_overload") is called async via safe(); advance clock past setTimeout
    clock.advance(1);

    // Give microtasks a chance to settle
    await new Promise((r) => setImmediate(r));
    expect(session.state).toBe("ended");
    expect((deps.metrics.voiceOverload.inc as any)).toHaveBeenCalled();
  });

  it("panic → ended with reason 'panic' when handler throws", async () => {
    const deps = makeDeps();
    // Make store.create throw to trigger panic
    (deps.store.create as any).mockRejectedValueOnce(new Error("redis down"));

    const session = new Session(deps);
    await session.bootstrap(); // internally catches error → end("panic")

    // After microtasks settle
    await new Promise((r) => setImmediate(r));
    expect(session.state).toBe("ended");
    expect((deps.metrics.sessionPanic.inc as any)).toHaveBeenCalled();
  });
});
