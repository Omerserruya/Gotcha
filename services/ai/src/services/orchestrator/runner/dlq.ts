import { getRedis } from "@chatcenter/shared";

/**
 * Dead-letter queue for tool executions that exhausted retries.
 *
 * Lifted from the dead voice-copilot Dispatcher pattern. Stores per-tenant
 * lists in Redis (`orchestrator:dlq:{tenantId}`) capped at 1000 entries.
 * On-call inspection: `redis-cli LRANGE orchestrator:dlq:<tenantId> 0 -1`.
 *
 * Phase 4 ships the DLQ writer; a polish pass can add a CLI/UI reader.
 */

const DLQ_MAX = 1000;

export interface DlqEntry {
  executionId: string;
  tenantId: string;
  conversationId: string;
  tool: string;
  args: Record<string, unknown>;
  error: string;
  attempts: number;
  failedAt: string;
}

export async function pushToDlq(entry: DlqEntry): Promise<void> {
  try {
    const redis = getRedis() as any;
    const key = `orchestrator:dlq:${entry.tenantId}`;
    await redis.lpush(key, JSON.stringify(entry));
    await redis.ltrim(key, 0, DLQ_MAX - 1);
  } catch (err: any) {
    // Even DLQ writes can fail in a Redis outage - log and drop.
    console.warn("[orchestrator.dlq] push failed:", err?.message);
  }
}
