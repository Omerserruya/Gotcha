import type { Redis } from "ioredis";
import type { SessionStore } from "./session-store";
import type { Clock } from "../lib/clock";
import type { Logger } from "../lib/logger";
import type { Metrics } from "../metrics/metrics";

const REAPER_LOCK_KEY = "voice:reaper:lock";
const LOCK_TTL_SECONDS = 90;
const SCAN_COUNT = 100;

export interface ReaperDeps {
  store: SessionStore;
  redis: Redis;
  clock: Clock;
  logger: Logger;
  metrics: Metrics;
  intervalMs: number;
  staleMs: number;
  endSession: (tenantId: string, conversationId: string, reason: "reaper") => Promise<void>;
}

export class Reaper {
  private intervalHandle: { cancel(): void } | null = null;

  constructor(private readonly deps: ReaperDeps) {}

  start(): void {
    if (this.intervalHandle) return; // already started
    this.intervalHandle = this.deps.clock.setInterval(
      () => void this.tick(),
      this.deps.intervalMs
    );
  }

  stop(): void {
    if (this.intervalHandle) {
      this.intervalHandle.cancel();
      this.intervalHandle = null;
    }
    // Release lock on stop (best-effort)
    this.deps.redis.del(REAPER_LOCK_KEY).catch(() => {/* ignore */});
  }

  private async tick(): Promise<void> {
    const { store, redis, clock, logger, metrics, staleMs, endSession } = this.deps;

    // 1. Try to acquire distributed lock
    const nodeId = `reaper-${process.pid}-${clock.now()}`;
    const acquired = await redis.set(REAPER_LOCK_KEY, nodeId, "EX", LOCK_TTL_SECONDS, "NX");
    if (!acquired) {
      logger.debug("reaper: lock held by peer, skipping tick");
      return;
    }

    try {
      const now = clock.now();
      let cursor = "0";

      do {
        let result: { cursor: string; members: string[] };
        try {
          result = await store.scanReaperSet(cursor, SCAN_COUNT);
        } catch (err) {
          logger.error({ err }, "reaper: scanReaperSet failed");
          break;
        }

        cursor = result.cursor;

        for (const member of result.members) {
          const sepIdx = member.indexOf("::");
          if (sepIdx === -1) continue;
          const tenantId = member.slice(0, sepIdx);
          const conversationId = member.slice(sepIdx + 2);

          try {
            const claimed = await store.reaperHandoff(tenantId, conversationId, now, staleMs);
            if (claimed) {
              logger.info({ tenantId, conversationId }, "reaper: claiming stale session");
              try {
                await endSession(tenantId, conversationId, "reaper");
              } catch (err) {
                logger.error({ err, tenantId, conversationId }, "reaper: endSession failed");
              }
              // Remove from reaper set + delete session key (brief grace already applied by endSession)
              await store.removeFromReaperSet(tenantId, conversationId);
              // Increment reaper metric
              metrics.sessionsEnded.inc({ tenant: tenantId, reason: "reaper" });
            }
          } catch (err) {
            logger.error({ err, tenantId, conversationId }, "reaper: reaperHandoff failed");
          }
        }
      } while (cursor !== "0");
    } finally {
      // Release lock
      await redis.del(REAPER_LOCK_KEY).catch(() => {/* ignore */});
    }
  }
}
