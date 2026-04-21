import {
  Registry,
  Gauge,
  Counter,
  Histogram,
  collectDefaultMetrics,
} from "prom-client";

export type { Registry, Gauge, Counter, Histogram };

export interface Metrics {
  registry: Registry;
  sessionsActive: Gauge;
  sessionsStarted: Counter;
  sessionsEnded: Counter;
  framesReceived: Counter;
  framesLateDropped: Counter;
  audioQueueDropped: Counter;
  dispatchLatency: Histogram;
  dispatchDeduped: Counter;
  dispatchFailed: Counter;
  dispatchRejected: Counter;
  sttErrors: Counter;
  reconnects: Counter;
  twilioAuthRejected: Counter;
  crossTenantRejected: Counter;
  sessionPanic: Counter;
  voiceOverload: Counter;
}

export function buildMetrics(): Metrics {
  const registry = new Registry();

  collectDefaultMetrics({ register: registry });

  const sessionsActive = new Gauge({
    name: "voice_sessions_active",
    help: "Number of currently active voice sessions",
    registers: [registry],
  });

  const sessionsStarted = new Counter({
    name: "voice_sessions_started_total",
    help: "Total voice sessions started",
    labelNames: ["tenant"],
    registers: [registry],
  });

  const sessionsEnded = new Counter({
    name: "voice_sessions_ended_total",
    help: "Total voice sessions ended",
    labelNames: ["tenant", "reason"],
    registers: [registry],
  });

  const framesReceived = new Counter({
    name: "voice_frames_received_total",
    help: "Total Twilio media frames received",
    labelNames: ["tenant", "speaker"],
    registers: [registry],
  });

  const framesLateDropped = new Counter({
    name: "voice_frames_late_dropped_total",
    help: "Total out-of-order frames dropped",
    labelNames: ["tenant"],
    registers: [registry],
  });

  const audioQueueDropped = new Counter({
    name: "voice_audio_queue_dropped_total",
    help: "Total audio chunks dropped due to full queue",
    labelNames: ["tenant", "speaker"],
    registers: [registry],
  });

  const dispatchLatency = new Histogram({
    name: "voice_dispatch_latency_ms",
    help: "Latency of dispatch to ai-assist in milliseconds",
    buckets: [10, 25, 50, 100, 200, 400, 800, 1600],
    registers: [registry],
  });

  const dispatchDeduped = new Counter({
    name: "voice_dispatch_deduped_total",
    help: "Total dispatches skipped due to idempotency deduplication",
    registers: [registry],
  });

  const dispatchFailed = new Counter({
    name: "voice_dispatch_failed_total",
    help: "Total dispatch failures after all retries",
    labelNames: ["status"],
    registers: [registry],
  });

  const dispatchRejected = new Counter({
    name: "voice_dispatch_rejected_total",
    help: "Total dispatches rejected by ai-assist",
    labelNames: ["status"],
    registers: [registry],
  });

  const sttErrors = new Counter({
    name: "voice_stt_errors_total",
    help: "Total STT errors by code",
    labelNames: ["code"],
    registers: [registry],
  });

  const reconnects = new Counter({
    name: "voice_reconnects_total",
    help: "Total WebSocket reconnects",
    labelNames: ["tenant"],
    registers: [registry],
  });

  const twilioAuthRejected = new Counter({
    name: "voice_twilio_auth_rejected_total",
    help: "Total Twilio signature rejections",
    registers: [registry],
  });

  const crossTenantRejected = new Counter({
    name: "voice_cross_tenant_rejected_total",
    help: "Total cross-tenant violations rejected",
    registers: [registry],
  });

  const sessionPanic = new Counter({
    name: "voice_session_panic_total",
    help: "Total sessions ended due to unhandled error (panic)",
    registers: [registry],
  });

  const voiceOverload = new Counter({
    name: "voice_overload_total",
    help: "Total sessions rejected due to STT overload",
    registers: [registry],
  });

  return {
    registry,
    sessionsActive,
    sessionsStarted,
    sessionsEnded,
    framesReceived,
    framesLateDropped,
    audioQueueDropped,
    dispatchLatency,
    dispatchDeduped,
    dispatchFailed,
    dispatchRejected,
    sttErrors,
    reconnects,
    twilioAuthRejected,
    crossTenantRejected,
    sessionPanic,
    voiceOverload,
  };
}
