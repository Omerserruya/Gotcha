import type { Redis } from "ioredis";

export type SessionState = "ringing" | "active" | "ended";

export interface SessionRecord {
  tenantId: string;
  conversationId: string;
  callSid: string;
  streamSid: string;
  agentId?: string;
  state: SessionState;
  startedAt: number;
  lastFrameAt: number;
  reconnectCount: number;
  framesReceived: number;
  framesDropped: number;
  transcriptsEmitted: number;
}

// ---------------------------------------------------------------------------
// Key helpers (§8)
// ---------------------------------------------------------------------------
function sessionKey(tenantId: string, conversationId: string): string {
  return `voice:tenant:${tenantId}:conversation:${conversationId}`;
}
function callSidKey(tenantId: string, callSid: string): string {
  return `voice:tenant:${tenantId}:callsid:${callSid}`;
}
function seqKey(tenantId: string, conversationId: string, speaker: "agent" | "customer"): string {
  return `voice:tenant:${tenantId}:seq:${conversationId}:${speaker}`;
}
function idemKey(tenantId: string, conversationId: string, speaker: "agent" | "customer", seq: number): string {
  return `voice:tenant:${tenantId}:idem:vs:${conversationId}:${speaker}:${seq}`;
}
const REAPER_SET = "voice:reaper:scan";
function reaperMember(tenantId: string, conversationId: string): string {
  return `${tenantId}::${conversationId}`;
}

// ---------------------------------------------------------------------------
// Lua scripts (verbatim from spec §8)
// ---------------------------------------------------------------------------
const RECONNECT_CLAIM_LUA = `
local st = redis.call('HGET', KEYS[1], 'state')
if not st then return nil end
if st == "ended" then return nil end
local lastFrame = tonumber(redis.call('HGET', KEYS[1], 'lastFrameAt') or "0")
if tonumber(ARGV[1]) - lastFrame > tonumber(ARGV[2]) then return nil end
redis.call('HINCRBY', KEYS[1], 'reconnectCount', 1)
return redis.call('HGETALL', KEYS[1])
`;

const REAPER_HANDOFF_LUA = `
local st = redis.call('HGET', KEYS[1], 'state')
if not st or st == "ended" then return 0 end
local lastFrame = tonumber(redis.call('HGET', KEYS[1], 'lastFrameAt') or "0")
if tonumber(ARGV[1]) - lastFrame <= tonumber(ARGV[2]) then return 0 end
redis.call('HSET', KEYS[1], 'state', 'ended')
return 1
`;

// ---------------------------------------------------------------------------
// Helper: convert HGETALL flat array to SessionRecord
// ---------------------------------------------------------------------------
function flatArrayToRecord(arr: string[]): SessionRecord | null {
  if (!arr || arr.length === 0) return null;
  const map: Record<string, string> = {};
  for (let i = 0; i < arr.length; i += 2) {
    map[arr[i]] = arr[i + 1];
  }
  if (!map["tenantId"] || !map["conversationId"]) return null;
  return {
    tenantId: map["tenantId"],
    conversationId: map["conversationId"],
    callSid: map["callSid"] ?? "",
    streamSid: map["streamSid"] ?? "",
    agentId: map["agentId"] || undefined,
    state: (map["state"] as SessionState) ?? "ringing",
    startedAt: Number(map["startedAt"] ?? 0),
    lastFrameAt: Number(map["lastFrameAt"] ?? 0),
    reconnectCount: Number(map["reconnectCount"] ?? 0),
    framesReceived: Number(map["framesReceived"] ?? 0),
    framesDropped: Number(map["framesDropped"] ?? 0),
    transcriptsEmitted: Number(map["transcriptsEmitted"] ?? 0),
  };
}

function recordToHash(record: SessionRecord): Record<string, string> {
  return {
    tenantId: record.tenantId,
    conversationId: record.conversationId,
    callSid: record.callSid,
    streamSid: record.streamSid,
    agentId: record.agentId ?? "",
    state: record.state,
    startedAt: String(record.startedAt),
    lastFrameAt: String(record.lastFrameAt),
    reconnectCount: String(record.reconnectCount),
    framesReceived: String(record.framesReceived),
    framesDropped: String(record.framesDropped),
    transcriptsEmitted: String(record.transcriptsEmitted),
  };
}

// ---------------------------------------------------------------------------
// SessionStore interface (used by Session + Reaper)
// ---------------------------------------------------------------------------
export interface SessionStore {
  create(record: SessionRecord, ttlSeconds: number): Promise<void>;
  get(tenantId: string, conversationId: string): Promise<SessionRecord | null>;
  updateState(tenantId: string, conversationId: string, state: SessionState): Promise<void>;
  refreshTtl(tenantId: string, conversationId: string, ttlSeconds: number): Promise<void>;
  incrField(tenantId: string, conversationId: string, field: keyof SessionRecord, by?: number): Promise<void>;
  touchLastFrame(tenantId: string, conversationId: string, ts: number): Promise<void>;
  findByCallSid(tenantId: string, callSid: string): Promise<string | null>;
  setCallSidIndex(tenantId: string, callSid: string, conversationId: string, ttlSeconds: number): Promise<void>;
  delete(tenantId: string, conversationId: string): Promise<void>;
  nextSeq(tenantId: string, conversationId: string, speaker: "agent" | "customer"): Promise<number>;
  claimIdempotency(tenantId: string, conversationId: string, speaker: "agent" | "customer", seq: number): Promise<boolean>;
  reconnectClaim(tenantId: string, conversationId: string, now: number, graceMs: number): Promise<SessionRecord | null>;
  reaperHandoff(tenantId: string, conversationId: string, now: number, staleMs: number): Promise<boolean>;
  addToReaperSet(tenantId: string, conversationId: string): Promise<void>;
  removeFromReaperSet(tenantId: string, conversationId: string): Promise<void>;
  scanReaperSet(cursor: string, count: number): Promise<{ cursor: string; members: string[] }>;
}

// ---------------------------------------------------------------------------
// RedisSessionStore - concrete implementation
// ---------------------------------------------------------------------------
class RedisSessionStore implements SessionStore {
  constructor(private readonly redis: Redis) {}

  async create(record: SessionRecord, ttlSeconds: number): Promise<void> {
    const key = sessionKey(record.tenantId, record.conversationId);
    const hash = recordToHash(record);
    const pipeline = this.redis.pipeline();
    // HSET key field1 val1 field2 val2 ...
    const hsetArgs: string[] = [];
    for (const [f, v] of Object.entries(hash)) {
      hsetArgs.push(f, v);
    }
    pipeline.hset(key, ...hsetArgs);
    pipeline.expire(key, ttlSeconds);
    pipeline.sadd(REAPER_SET, reaperMember(record.tenantId, record.conversationId));
    await pipeline.exec();
  }

  async get(tenantId: string, conversationId: string): Promise<SessionRecord | null> {
    const key = sessionKey(tenantId, conversationId);
    const raw = await this.redis.hgetall(key);
    if (!raw || Object.keys(raw).length === 0) return null;
    // hgetall returns object, not array - convert
    const arr: string[] = [];
    for (const [k, v] of Object.entries(raw)) {
      arr.push(k, v);
    }
    return flatArrayToRecord(arr);
  }

  async updateState(tenantId: string, conversationId: string, state: SessionState): Promise<void> {
    const key = sessionKey(tenantId, conversationId);
    await this.redis.hset(key, "state", state);
  }

  async refreshTtl(tenantId: string, conversationId: string, ttlSeconds: number): Promise<void> {
    const key = sessionKey(tenantId, conversationId);
    await this.redis.expire(key, ttlSeconds);
  }

  async incrField(tenantId: string, conversationId: string, field: keyof SessionRecord, by = 1): Promise<void> {
    const key = sessionKey(tenantId, conversationId);
    await this.redis.hincrby(key, field as string, by);
  }

  async touchLastFrame(tenantId: string, conversationId: string, ts: number): Promise<void> {
    const key = sessionKey(tenantId, conversationId);
    await this.redis.hset(key, "lastFrameAt", String(ts));
  }

  async findByCallSid(tenantId: string, callSid: string): Promise<string | null> {
    const key = callSidKey(tenantId, callSid);
    return this.redis.get(key);
  }

  async setCallSidIndex(tenantId: string, callSid: string, conversationId: string, ttlSeconds: number): Promise<void> {
    const key = callSidKey(tenantId, callSid);
    await this.redis.set(key, conversationId, "EX", ttlSeconds);
  }

  async delete(tenantId: string, conversationId: string): Promise<void> {
    const pipeline = this.redis.pipeline();
    pipeline.del(sessionKey(tenantId, conversationId));
    pipeline.srem(REAPER_SET, reaperMember(tenantId, conversationId));
    await pipeline.exec();
    // Note: callSid index is DEL'd separately (caller has callSid)
  }

  async nextSeq(tenantId: string, conversationId: string, speaker: "agent" | "customer"): Promise<number> {
    const key = seqKey(tenantId, conversationId, speaker);
    const val = await this.redis.incr(key);
    // Set TTL on first creation
    await this.redis.expire(key, 900);
    return val;
  }

  async claimIdempotency(tenantId: string, conversationId: string, speaker: "agent" | "customer", seq: number): Promise<boolean> {
    const key = idemKey(tenantId, conversationId, speaker, seq);
    const result = await this.redis.set(key, "1", "EX", 3600, "NX");
    return result === "OK";
  }

  async reconnectClaim(tenantId: string, conversationId: string, now: number, graceMs: number): Promise<SessionRecord | null> {
    const key = sessionKey(tenantId, conversationId);
    const result = await this.redis.eval(
      RECONNECT_CLAIM_LUA,
      1,
      key,
      String(now),
      String(graceMs)
    ) as string[] | null;
    if (!result || result.length === 0) return null;
    return flatArrayToRecord(result);
  }

  async reaperHandoff(tenantId: string, conversationId: string, now: number, staleMs: number): Promise<boolean> {
    const key = sessionKey(tenantId, conversationId);
    const result = await this.redis.eval(
      REAPER_HANDOFF_LUA,
      1,
      key,
      String(now),
      String(staleMs)
    ) as number;
    return result === 1;
  }

  async addToReaperSet(tenantId: string, conversationId: string): Promise<void> {
    await this.redis.sadd(REAPER_SET, reaperMember(tenantId, conversationId));
  }

  async removeFromReaperSet(tenantId: string, conversationId: string): Promise<void> {
    await this.redis.srem(REAPER_SET, reaperMember(tenantId, conversationId));
  }

  async scanReaperSet(cursor: string, count: number): Promise<{ cursor: string; members: string[] }> {
    const [nextCursor, members] = await this.redis.sscan(REAPER_SET, cursor, "COUNT", count);
    return { cursor: nextCursor, members };
  }
}

export function createSessionStore(redis: Redis): SessionStore {
  return new RedisSessionStore(redis);
}
