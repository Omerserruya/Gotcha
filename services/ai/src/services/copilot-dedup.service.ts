// Copilot request-deduplication / idempotency layer.
//
// Why this exists:
// The frontend (`CoPilotPanel.tsx`) fires one `fetchAI()` per inbound
// message with a 1.5s client-side debounce. When customers send a burst
// of messages, multiple `fetchAI()` calls hit the backend in quick
// succession. Each starts a full LLM round inside `suggestResponse()`
// which rebuilds `chatMessages` from scratch and pays the full system
// prompt cost - even when the AbortController on the client kills the
// HTTP response, the backend has already burned tokens.
//
// Measured impact in dev DB: ~60% of "excess" rounds beyond 2 in P95
// copilot sessions are FE-refire restarts of identical work.
//
// This module provides two cooperating guards:
//   1. CONCURRENCY GUARD - per-conversation in-flight Promise. A new
//      request for a conversation already being processed attaches to
//      the existing Promise instead of starting a new one.
//   2. IDEMPOTENCY GUARD - per-requestInstanceId cache. If the same
//      `requestInstanceId` arrives twice (network retry, react double-
//      fire, etc.), the second one returns the first's result.
//
// Both guards are in-process. For a multi-replica deployment a future
// upgrade to a Redis-backed lock would let dedup work across replicas;
// for the current single-EC2 deployment in-process is sufficient and
// has zero network overhead.

export type DedupReason = "primary" | "attached" | "idempotent";

export interface DedupOutcome<T> {
  result: T;
  reason: DedupReason;
  // For observability - wall-clock latency the caller waited for.
  waitedMs: number;
}

interface InflightEntry<T> {
  promise: Promise<T>;
  startedAt: number;
  requestInstanceIds: Set<string>;
}

interface IdempotentEntry<T> {
  result: T;
  // Epoch ms when the cached result expires.
  expiresAt: number;
}

// 60s TTL on idempotency cache - long enough to survive a retry storm,
// short enough that fresh requests with the same instanceId after the
// burst are handled correctly. The frontend re-generates the id per
// `fetchAI()` invocation, so collisions across distinct triggers are
// not expected.
const IDEMPOTENCY_TTL_MS = 60_000;

// Periodically prune expired idempotency entries so the map can't grow
// without bound on a long-running process.
const PRUNE_INTERVAL_MS = 30_000;

const inflight = new Map<string, InflightEntry<unknown>>();
const idempotent = new Map<string, IdempotentEntry<unknown>>();

let pruneTimer: NodeJS.Timeout | null = null;
function ensurePruner() {
  if (pruneTimer) return;
  pruneTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of idempotent) {
      if (v.expiresAt <= now) idempotent.delete(k);
    }
  }, PRUNE_INTERVAL_MS);
  // Don't keep the event loop alive solely for the pruner.
  pruneTimer.unref?.();
}

interface RunDedupedArgs<T> {
  // Concurrency key - typically the conversationId.
  key: string;
  // Optional idempotency key - the client-supplied requestInstanceId.
  // When provided and seen recently, the cached result is returned.
  requestInstanceId?: string;
  // The actual work - invoked once per dedup'd group of callers.
  fn: () => Promise<T>;
}

/**
 * Run `fn` under per-key concurrency + per-instance idempotency.
 *
 * Behavior:
 *   - If `requestInstanceId` is in the idempotency cache → return its
 *     cached result without running `fn`. Reason: "idempotent".
 *   - Else if `key` has an in-flight Promise → attach to it. The same
 *     Promise's resolved value is returned to all attached waiters.
 *     Reason: "attached".
 *   - Else start a new Promise, store it under `key`, run `fn`, and on
 *     completion cache the result under each registered instanceId for
 *     `IDEMPOTENCY_TTL_MS`. Reason: "primary".
 *
 * `fn` is invoked exactly once per dedup'd group. If it throws, the
 * rejection propagates to all waiters and nothing is cached.
 */
export async function runDeduped<T>({ key, requestInstanceId, fn }: RunDedupedArgs<T>): Promise<DedupOutcome<T>> {
  ensurePruner();
  const startedAt = Date.now();

  // 1. Idempotency cache hit - return immediately.
  if (requestInstanceId) {
    const cached = idempotent.get(requestInstanceId) as IdempotentEntry<T> | undefined;
    if (cached && cached.expiresAt > startedAt) {
      return { result: cached.result, reason: "idempotent", waitedMs: 0 };
    }
  }

  // 2. Concurrency attach - there's already an in-flight call for this key.
  const existing = inflight.get(key) as InflightEntry<T> | undefined;
  if (existing) {
    if (requestInstanceId) existing.requestInstanceIds.add(requestInstanceId);
    const result = await existing.promise;
    return { result, reason: "attached", waitedMs: Date.now() - startedAt };
  }

  // 3. Primary path - start, register, run, cleanup.
  const requestInstanceIds = new Set<string>();
  if (requestInstanceId) requestInstanceIds.add(requestInstanceId);

  const promise = (async () => fn())();
  const entry: InflightEntry<T> = { promise, startedAt, requestInstanceIds };
  inflight.set(key, entry as InflightEntry<unknown>);

  try {
    const result = await promise;
    // Cache the result for every instanceId that joined this run so
    // subsequent retries with any of them short-circuit.
    const expiresAt = Date.now() + IDEMPOTENCY_TTL_MS;
    for (const id of requestInstanceIds) {
      idempotent.set(id, { result, expiresAt } as IdempotentEntry<unknown>);
    }
    return { result, reason: "primary", waitedMs: Date.now() - startedAt };
  } finally {
    // Always clear the in-flight slot, success or failure, so the next
    // request after this one runs fresh.
    if (inflight.get(key) === (entry as InflightEntry<unknown>)) {
      inflight.delete(key);
    }
  }
}

// Test-only - clear all state. Not exported via index; used by unit tests.
export function __resetCopilotDedupForTests() {
  inflight.clear();
  idempotent.clear();
}

// Lightweight snapshot for /health or debug endpoints.
export function getCopilotDedupStats() {
  return {
    inflight: inflight.size,
    idempotent: idempotent.size,
  };
}
