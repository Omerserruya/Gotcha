import { createHash } from "crypto";
import type { Redis } from "ioredis";
import type { AiAssistClient, PostResult, VoiceStreamBody } from "./ai-assist-client";
import type { Clock } from "../lib/clock";
import type { Logger } from "../lib/logger";
import type { Metrics } from "../metrics/metrics";
import type { Transcript } from "../stt/provider";
import { DispatchDLQError } from "../lib/errors";

export interface DispatchItem {
  tenantId: string;
  conversationId: string;
  message: Transcript;
}

export interface DispatcherDeps {
  // broad type so app.ts can pass postVoiceStream cast as (body: unknown, opts: unknown) => Promise<unknown>
  client: (body: unknown, opts: unknown) => Promise<unknown>;
  redis: Redis;
  aiServiceUrl: string;
  internalKey: string;
  clock: Clock;
  /** defaults to Math.random if omitted */
  random?: () => number;
  logger: Logger;
  metrics: Metrics;
  batchWindowMs: number;
  batchMax: number;
  retryScheduleMs: number[];
  dlqMaxLen?: number;
  circuitThresholdFailures?: number;
  circuitWindowMs?: number;
  circuitOpenMs?: number;
}

interface BatchGroup {
  items: DispatchItem[];
  timer: { cancel(): void } | null;
}

interface CircuitBreakerState {
  failures: number[]; // timestamps of failures
  requests: number[]; // timestamps of all requests
  openUntil: number;  // 0 = closed
  halfOpen: boolean;
}

type CircuitStatus = "closed" | "open" | "half_open";

export class Dispatcher {
  private readonly dlqMaxLen: number;
  private readonly circuitThresholdFailures: number;
  private readonly circuitWindowMs: number;
  private readonly circuitOpenMs: number;

  // Map<`${tenantId}:${conversationId}:${speaker}`, BatchGroup>
  private readonly pending = new Map<string, BatchGroup>();

  // Per-tenant circuit breaker state
  private readonly circuits = new Map<string, CircuitBreakerState>();

  constructor(private readonly deps: DispatcherDeps) {
    this.dlqMaxLen = deps.dlqMaxLen ?? 10_000;
    this.circuitThresholdFailures = deps.circuitThresholdFailures ?? 20;
    this.circuitWindowMs = deps.circuitWindowMs ?? 60_000;
    this.circuitOpenMs = deps.circuitOpenMs ?? 30_000;
  }

  enqueue(item: DispatchItem): void {
    const groupKey = `${item.tenantId}:${item.conversationId}:${item.message.speaker}`;

    let group = this.pending.get(groupKey);
    if (!group) {
      group = { items: [], timer: null };
      this.pending.set(groupKey, group);
    }

    group.items.push(item);

    if (group.items.length >= this.deps.batchMax) {
      // flush immediately
      if (group.timer) {
        group.timer.cancel();
        group.timer = null;
      }
      this.pending.delete(groupKey);
      this.flushGroup(groupKey, group.items).catch((err) => {
        this.deps.logger.error({ err, groupKey }, "flush error");
      });
    } else if (!group.timer) {
      group.timer = this.deps.clock.setTimeout(() => {
        const g = this.pending.get(groupKey);
        if (g) {
          this.pending.delete(groupKey);
          this.flushGroup(groupKey, g.items).catch((err) => {
            this.deps.logger.error({ err, groupKey }, "flush error");
          });
        }
      }, this.deps.batchWindowMs);
    }
  }

  async flushSession(tenantId: string, conversationId: string): Promise<void> {
    const toFlush: Array<{ key: string; items: DispatchItem[] }> = [];

    for (const [key, group] of this.pending.entries()) {
      if (key.startsWith(`${tenantId}:${conversationId}:`)) {
        if (group.timer) group.timer.cancel();
        toFlush.push({ key, items: group.items });
        this.pending.delete(key);
      }
    }

    await Promise.all(
      toFlush.map(({ key, items }) =>
        this.flushGroup(key, items).catch((err) => {
          this.deps.logger.error({ err, key }, "flushSession error");
        })
      )
    );
  }

  circuitState(tenantId: string): CircuitStatus {
    const cb = this.circuits.get(tenantId);
    if (!cb) return "closed";
    const now = this.deps.clock.now();
    if (cb.openUntil === 0) return "closed";
    if (cb.halfOpen) {
      // still in half-open probe window
      return cb.openUntil > now ? "half_open" : "closed";
    }
    if (cb.openUntil <= now) {
      // open window has expired → transition to half_open
      cb.halfOpen = true;
      cb.openUntil = now + this.circuitOpenMs; // probe window
      return "half_open";
    }
    return "open";
  }

  private getCircuit(tenantId: string): CircuitBreakerState {
    let cb = this.circuits.get(tenantId);
    if (!cb) {
      cb = { failures: [], requests: [], openUntil: 0, halfOpen: false };
      this.circuits.set(tenantId, cb);
    }
    return cb;
  }

  private pruneCircuit(cb: CircuitBreakerState, now: number): void {
    const cutoff = now - this.circuitWindowMs;
    cb.failures = cb.failures.filter((t) => t > cutoff);
    cb.requests = cb.requests.filter((t) => t > cutoff);
  }

  private recordCircuitSuccess(tenantId: string): void {
    const cb = this.getCircuit(tenantId);
    const now = this.deps.clock.now();
    cb.requests.push(now);
    if (cb.halfOpen) {
      // probe succeeded: CLOSED
      cb.openUntil = 0;
      cb.halfOpen = false;
    }
  }

  private recordCircuitFailure(tenantId: string): void {
    const cb = this.getCircuit(tenantId);
    const now = this.deps.clock.now();
    cb.failures.push(now);
    cb.requests.push(now);
    this.pruneCircuit(cb, now);

    if (
      cb.failures.length >= this.circuitThresholdFailures &&
      cb.requests.length > 0 &&
      cb.failures.length / cb.requests.length >= 0.5
    ) {
      cb.openUntil = now + this.circuitOpenMs;
      cb.halfOpen = false;
    }
  }

  private isCircuitOpen(tenantId: string): boolean {
    const cb = this.getCircuit(tenantId);
    this.pruneCircuit(cb, this.deps.clock.now());
    const state = this.circuitState(tenantId);
    if (state === "closed") return false;
    if (state === "half_open") {
      // Allow exactly one probe through; mark that probe is in flight by treating subsequent as open.
      // The probe result will call recordCircuitSuccess/Failure to close/reopen.
      // We allow the probe (return false) but leave halfOpen=true so others are blocked.
      return false;
    }
    // open
    return true;
  }

  private buildIdempotencyKey(
    tenantId: string,
    conversationId: string,
    speaker: string,
    minSeq: number,
    maxSeq: number
  ): string {
    const raw = `${tenantId}:${conversationId}:${speaker}:${minSeq}-${maxSeq}`;
    return createHash("sha256").update(raw).digest("hex");
  }

  private async sendToDlq(
    tenantId: string,
    conversationId: string,
    body: VoiceStreamBody,
    attempts: number,
    lastStatus: number,
    reason = "exhausted"
  ): Promise<void> {
    const entry = JSON.stringify({
      ts: this.deps.clock.now(),
      tenantId,
      conversationId,
      body,
      attempts,
      lastStatus,
      reason,
    });
    const pipeline = this.deps.redis.pipeline();
    pipeline.lpush(`voice:dlq:${tenantId}`, entry);
    pipeline.ltrim(`voice:dlq:${tenantId}`, 0, this.dlqMaxLen - 1);
    await pipeline.exec();
  }

  private async sendWithRetry(
    tenantId: string,
    conversationId: string,
    body: VoiceStreamBody,
    idempotencyKey: string
  ): Promise<void> {
    const { retryScheduleMs, clock, metrics, logger, aiServiceUrl, internalKey } = this.deps;
    const random = this.deps.random ?? Math.random;
    const client = this.deps.client as AiAssistClient;

    let lastStatus = 0;
    let attempts = 0;

    for (let attempt = 0; attempt <= retryScheduleMs.length; attempt++) {
      attempts = attempt + 1;
      const start = clock.now();
      const result: PostResult = await client(body, {
        aiServiceUrl,
        internalKey,
        tenantId,
        idempotencyKey,
        timeoutMs: 2000,
      });
      const latency = clock.now() - start;
      lastStatus = result.status;

      if (result.ok) {
        metrics.dispatchLatency.observe(latency);
        this.recordCircuitSuccess(tenantId);
        return;
      }

      if (result.status === 409) {
        metrics.dispatchDeduped.inc();
        this.recordCircuitSuccess(tenantId);
        return;
      }

      if (result.status >= 400 && result.status < 500) {
        // 4xx (not 409): log warn, increment rejected, do not retry
        logger.warn({ status: result.status, tenantId, conversationId }, "dispatch rejected by ai-assist");
        metrics.dispatchRejected.inc({ status: String(result.status) });
        this.recordCircuitFailure(tenantId);
        return;
      }

      // 5xx or network error
      metrics.dispatchFailed.inc({ status: String(result.status ?? 0) });
      this.recordCircuitFailure(tenantId);

      if (attempt === retryScheduleMs.length) {
        // exhausted
        await this.sendToDlq(tenantId, conversationId, body, attempts, lastStatus);
        throw new DispatchDLQError(body);
      }

      const base = retryScheduleMs[attempt];
      const jitter = base * (1 + (random() - 0.5) * 0.2);
      await new Promise<void>((resolve) => {
        clock.setTimeout(resolve, jitter);
      });
    }
  }

  private async flushGroup(groupKey: string, items: DispatchItem[]): Promise<void> {
    if (items.length === 0) return;

    const { tenantId, conversationId } = items[0];

    // Check circuit breaker
    if (this.isCircuitOpen(tenantId)) {
      this.deps.metrics.dispatchFailed.inc({ status: "circuit_open" });
      // Send all to DLQ directly
      const body: VoiceStreamBody = {
        type: "voice_stream",
        tenantId,
        conversationId,
        messages: items.map((i) => i.message),
      };
      await this.sendToDlq(tenantId, conversationId, body, 0, 0, "circuit_open");
      return;
    }

    // Idempotency check via Redis pipeline
    const pipeline = this.deps.redis.pipeline();
    for (const item of items) {
      const redisKey = `voice:tenant:${item.tenantId}:idem:vs:${item.conversationId}:${item.message.speaker}:${item.message.seq}`;
      pipeline.set(redisKey, "1", "EX", 3600, "NX");
    }
    const results = await pipeline.exec();

    // Filter to claimed items only (SET NX returns "OK" if claimed, null if already exists)
    const claimedItems: DispatchItem[] = [];
    if (results) {
      for (let i = 0; i < results.length; i++) {
        const [err, val] = results[i];
        if (err) continue;
        if (val === null) {
          // already dispatched
          this.deps.metrics.dispatchDeduped.inc();
        } else {
          claimedItems.push(items[i]);
        }
      }
    }

    if (claimedItems.length === 0) return;

    // Group claimed items by speaker (batches must share a speaker)
    const bySpeaker = new Map<string, DispatchItem[]>();
    for (const item of claimedItems) {
      const speaker = item.message.speaker;
      const group = bySpeaker.get(speaker) ?? [];
      group.push(item);
      bySpeaker.set(speaker, group);
    }

    for (const [speaker, speakerItems] of bySpeaker.entries()) {
      const seqs = speakerItems.map((i) => i.message.seq);
      const minSeq = Math.min(...seqs);
      const maxSeq = Math.max(...seqs);
      const idempotencyKey = this.buildIdempotencyKey(
        tenantId,
        conversationId,
        speaker,
        minSeq,
        maxSeq
      );

      const body: VoiceStreamBody = {
        type: "voice_stream",
        tenantId,
        conversationId,
        messages: speakerItems.map((i) => i.message),
      };

      await this.sendWithRetry(tenantId, conversationId, body, idempotencyKey);
    }
  }
}
