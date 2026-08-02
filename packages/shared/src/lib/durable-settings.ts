/**
 * Admin-configured tenant settings that must survive a restart.
 *
 * Business hours, the auto-greeting template and SLA targets used to live only
 * in Redis, under keys with no TTL - a cache holding the sole copy of
 * configuration a customer deliberately set.
 *
 * Production Redis has a volume and appendonly (added for BullMQ, which covered
 * these keys by accident); the dev compose file had no volume at all, so every
 * `docker compose down` erased them there. The architecture is the real
 * problem: a FLUSHALL, an eviction, or a volume migration takes configuration
 * with it, and those are ordinary things to do to a cache.
 *
 * What made that dangerous rather than merely annoying is how the reads
 * degrade. A missing business-hours config evaluates as OPEN, deliberately:
 *
 *     // Config store unreachable → answer as open, matching what the AI
 *     // employee does. A widget that says "we are closed" because Redis
 *     // blinked is worse than one that answers out of hours.
 *
 * That is the right call for a blip and the wrong one for a permanent loss.
 * Whenever the key does go, the tenant simply becomes 24/7 - the AI answering
 * at 3am as though someone were there to escalate to - and nothing logs an
 * error, because "open" is also the healthy answer. A failure mode that is
 * indistinguishable from health is one nobody reports.
 *
 * So: Postgres is the source of truth, Redis stays in front as the cache the
 * hot paths already read. The cache keys are unchanged, which is what lets the
 * existing readers keep working untouched while they migrate one at a time.
 *
 * Reads are cache-first with a Postgres fallback that REPOPULATES, so the first
 * request after a restart repairs the cache for everyone behind it.
 */

import { prisma } from "./prisma";
import { getRedis } from "./redis";

/**
 * How long the cache gets to answer before we go to the database instead.
 *
 * A cache exists to make things faster. Without a bound it can only make them
 * slower: ioredis retries a dead connection ~20 times, so a Redis that is down
 * turns every settings read into seconds of waiting before the Postgres
 * fallback - which was sitting there ready the whole time. Short enough that a
 * healthy Redis always wins, long enough that a briefly busy one is not
 * abandoned.
 */
const CACHE_TIMEOUT_MS = 250;

async function withCacheTimeout<T>(work: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("cache_timeout")), CACHE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The Redis cache key for a setting. ALWAYS scoped by tenant.
 *
 * Tenant-scoped keys keep the exact shape the existing readers use
 * (`tenant:{id}:businessHours`), so nothing had to move at once.
 *
 * Department keys did NOT: they were stored globally as
 * `department:{departmentId}:sla`, with no tenant in the key at all. That is
 * fine while every read goes through a route that has already resolved the
 * department inside the caller's tenant - and it stops being fine the moment a
 * helper like this one makes the lookup available by id. A cache read happens
 * before any database row is consulted, so an unscoped key hands one tenant's
 * value to another without ever touching the row that records who owns it.
 *
 * The legacy global key is therefore superseded here rather than preserved.
 * `scripts/backfill-durable-settings.ts` reads the old key and writes the
 * value under the new one, so nothing is lost; the stale global key is simply
 * no longer read.
 */
export function settingCacheKey(tenantId: string, key: string): string {
  return `tenant:${tenantId}:${key}`;
}

/** The pre-migration key for a department SLA, read only by the backfill. */
export function legacyDepartmentSlaKey(departmentId: string): string {
  return `department:${departmentId}:sla`;
}

/**
 * Read a setting: cache first, database second, and refill the cache on a miss.
 *
 * Returns the raw string the callers already expect (they parse it themselves),
 * or null when the setting has never been configured.
 */
export async function readDurableSetting(tenantId: string, key: string): Promise<string | null> {
  const cacheKey = settingCacheKey(tenantId, key);

  try {
    const cached = await withCacheTimeout(() => getRedis().get(cacheKey));
    if (cached !== null && cached !== undefined) return cached;
  } catch {
    // Cache unreachable or too slow - fall through to the database rather than
    // reporting "not configured", which is the failure that made this whole
    // class of bug invisible.
  }

  let row: { value: unknown } | null = null;
  try {
    row = await (prisma as any).tenantSetting.findUnique({
      where: { tenantId_key: { tenantId, key } },
      select: { value: true },
    });
  } catch (err: any) {
    console.warn(`[durable-settings] read failed for ${tenantId}/${key}: ${err?.message}`);
    return null;
  }
  if (!row) return null;

  const raw = typeof row.value === "string" ? row.value : JSON.stringify(row.value);

  // Repair the cache so the next reader does not pay for this again.
  try {
    await withCacheTimeout(() => getRedis().set(cacheKey, raw));
  } catch {
    // Best effort. A cold cache is slow, not wrong.
  }
  return raw;
}

/**
 * Write a setting durably, then mirror it to the cache.
 *
 * Database FIRST and deliberately: if the mirror fails, the value is still
 * saved and the next cache miss will serve it. The other order would report
 * success for a value that vanishes on the next restart - exactly the bug this
 * module exists to close.
 *
 * `value` of null deletes the setting.
 */
export async function writeDurableSetting(
  tenantId: string,
  key: string,
  value: string | null,
  updatedBy?: string,
): Promise<void> {
  const cacheKey = settingCacheKey(tenantId, key);

  if (value === null) {
    await (prisma as any).tenantSetting
      .deleteMany({ where: { tenantId, key } })
      .catch((err: any) => console.warn(`[durable-settings] delete failed: ${err?.message}`));
    await withCacheTimeout(() => getRedis().del(cacheKey)).catch(() => {});
    return;
  }

  // Stored as Json. A setting that is already JSON keeps its structure so it is
  // queryable; anything else is kept as a JSON string rather than rejected.
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = value;
  }

  await (prisma as any).tenantSetting.upsert({
    where: { tenantId_key: { tenantId, key } },
    create: { tenantId, key, value: parsed as any, updatedBy },
    update: { value: parsed as any, updatedBy },
  });

  try {
    await withCacheTimeout(() => getRedis().set(cacheKey, value));
  } catch (err: any) {
    // The durable write already succeeded, so this is recoverable on the next
    // read. Logged because a persistently failing mirror means every read is
    // hitting Postgres.
    console.warn(`[durable-settings] cache mirror failed for ${cacheKey}: ${err?.message}`);
  }
}
