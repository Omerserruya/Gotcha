/**
 * Webhook dedupe + retry-safety primitive.
 *
 * Pattern:
 *   1. begin()    — Redis SETNX with `pending` marker + short TTL. If the key
 *                   already exists, returns the existing status so the handler
 *                   can treat it as "already in progress" or "already done".
 *   2. complete() — flips the marker to `complete` and extends TTL (typically
 *                   24h) so subsequent retries of the same event are dropped.
 *   3. fail()     — DELETEs the key so a Twilio retry re-enters the pipeline.
 *
 * This is what lets us comply with the "let Twilio retry on internal failures"
 * contract: we only persist a "complete" marker once the DB transaction
 * actually commits. If anything in between blows up, fail() wipes the key.
 */
import type { Redis } from "ioredis";

export type DedupeStatus = "fresh" | "pending" | "complete";

export interface DedupeHandle {
  status: DedupeStatus;
  complete(): Promise<void>;
  fail(): Promise<void>;
}

const PENDING_TTL_SECONDS = 60;       // covers a slow handler / DB write
const COMPLETE_TTL_SECONDS = 24 * 60 * 60; // 24h — well past Twilio retry budget

export async function begin(redis: Redis, key: string): Promise<DedupeHandle> {
  const fullKey = `webhook:dedupe:${key}`;
  const setResult = await redis.set(fullKey, "pending", "EX", PENDING_TTL_SECONDS, "NX");
  if (setResult === "OK") {
    return {
      status: "fresh",
      complete: async () => { await redis.set(fullKey, "complete", "EX", COMPLETE_TTL_SECONDS); },
      fail:     async () => { await redis.del(fullKey); },
    };
  }
  const current = (await redis.get(fullKey)) as DedupeStatus | null;
  return {
    status: current === "complete" ? "complete" : "pending",
    complete: async () => { /* no-op: another worker owns the lifecycle */ },
    fail:     async () => { /* no-op: don't disturb the in-flight handler */ },
  };
}
