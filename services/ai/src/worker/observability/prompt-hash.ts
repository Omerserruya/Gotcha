/**
 * Prompt-prefix fingerprint + invariant check.
 *
 * The load-bearing property of the unified AI Worker is that every call
 * within a session sends OpenAI a BYTE-IDENTICAL message prefix. When
 * the bytes are stable, OpenAI's automatic prefix cache hits (after the
 * first call) and we save 50% on input-token cost for the cached portion.
 *
 * This module:
 *   1. Hashes the cacheable prefix (SYSTEM_CORE + SESSION_PROFILE)
 *   2. Provides an in-memory map of "last seen hash per sessionId"
 *   3. Asserts the hash hasn't drifted on each call — dev throws,
 *      prod logs a structured warning so we can alert on it
 *
 * The map is process-local. That's fine — if the same conversation gets
 * served by a different process, both processes will compute the same
 * hash on first call and OpenAI's cache will still hit (the cache lives
 * server-side at OpenAI, not in our process).
 */

import { createHash } from "crypto";
import type { AIWorkerPromptFingerprint } from "@chatcenter/shared";

/**
 * Compute the deterministic prefix fingerprint for a session.
 *
 * Bytes-only hash: we hash the exact strings that will be sent to OpenAI
 * as the system-role messages. Whitespace matters. Order matters.
 */
export function fingerprintPrefix(
  systemCore: string,
  sessionProfile: string,
): AIWorkerPromptFingerprint {
  const h = createHash("sha256");
  h.update(systemCore);
  // Newline separator so two empty halves can't accidentally hash equal
  // to one non-empty half.
  h.update("\n----\n");
  h.update(sessionProfile);
  return {
    hash: h.digest("hex").slice(0, 32), // 128 bits — plenty for collision
    systemCoreBytes: Buffer.byteLength(systemCore, "utf8"),
    sessionProfileBytes: Buffer.byteLength(sessionProfile, "utf8"),
  };
}

// ─── Drift detector ─────────────────────────────────────────────

const SEEN: Map<string, string> = new Map();
const MAX_TRACKED_SESSIONS = 10_000; // prevent unbounded growth

export interface HashDriftResult {
  sessionId: string;
  hash: string;
  /** First time we've seen this session — no prior hash to compare. */
  firstSeen: boolean;
  /** True iff the hash differs from a previously-recorded one. */
  drifted: boolean;
  /** Prior hash, when drifted. */
  priorHash?: string;
}

/**
 * Record a fingerprint for a sessionId and report whether it drifted.
 *
 * Behaviour:
 *   - First call for a sessionId → firstSeen=true, drifted=false
 *   - Subsequent call with same hash → firstSeen=false, drifted=false
 *   - Subsequent call with different hash → drifted=true
 *
 * Callers decide what to do on drift (throw in dev, log+alert in prod).
 * This function never throws — it's pure observability.
 */
export function recordPrefixFingerprint(
  sessionId: string,
  hash: string,
): HashDriftResult {
  // Cheap GC: when we hit the bound, drop the oldest half.
  // Map iteration is insertion-ordered so the first entries are oldest.
  if (SEEN.size >= MAX_TRACKED_SESSIONS) {
    const drop = Math.floor(MAX_TRACKED_SESSIONS / 2);
    let i = 0;
    for (const k of SEEN.keys()) {
      if (i++ >= drop) break;
      SEEN.delete(k);
    }
  }

  const prior = SEEN.get(sessionId);
  if (!prior) {
    SEEN.set(sessionId, hash);
    return { sessionId, hash, firstSeen: true, drifted: false };
  }
  if (prior === hash) {
    return { sessionId, hash, firstSeen: false, drifted: false };
  }
  return {
    sessionId,
    hash,
    firstSeen: false,
    drifted: true,
    priorHash: prior,
  };
}

/**
 * Assert no drift. Throws in non-production environments so unit /
 * integration tests catch the bug at the source. In production, logs a
 * structured warning and returns — never blocks the live AI call.
 */
export function assertPrefixStability(result: HashDriftResult): void {
  if (!result.drifted) return;
  const msg = `[prompt-hash] DRIFT for session ${result.sessionId}: ${result.priorHash} → ${result.hash}. OpenAI prefix cache will MISS this call.`;
  if (process.env.NODE_ENV !== "production") {
    throw new Error(msg);
  }
  console.warn(msg, {
    sessionId: result.sessionId,
    priorHash: result.priorHash,
    nextHash: result.hash,
    severity: "cache_invariant_violation",
  });
}

/** Test-only: clear the seen map. Never call from production code. */
export function __clearSeenForTests(): void {
  SEEN.clear();
}
