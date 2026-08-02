import { Queue } from "bullmq";
import { createWorker, prisma } from "@chatcenter/shared";
import * as confluenceService from "./confluence.service";
import * as googleDriveService from "./google-drive.service";

/**
 * Knowledge-base auto-sync.
 *
 * A repeatable BullMQ tick (hourly by default) re-runs the existing Drive /
 * Confluence sync for every active integration that (a) has auto-sync enabled
 * and (b) has a persisted selection (config.spaceKeys / config.fileIds, written
 * the first time the admin syncs manually). The connectors themselves are
 * change-aware - unchanged pages/files are skipped via their version marker, so
 * a tick only re-embeds what actually changed at the source.
 */

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const QUEUE_NAME = "knowledge-sync";
// Hourly on the hour. Overridable for ops/tests via a standard cron expression.
const SYNC_CRON = process.env.KNOWLEDGE_SYNC_CRON || "0 * * * *";

const knowledgeSyncQueue = new Queue(QUEUE_NAME, { connection: { url: REDIS_URL } });

export interface SyncCounts { imported: number; updated: number; skipped: number }

/** Re-sync one integration from its persisted selection. */
export async function reSyncIntegration(integration: any): Promise<SyncCounts> {
  const cfg = (integration?.config && typeof integration.config === "object" ? integration.config : {}) as any;
  const counts: SyncCounts = { imported: 0, updated: 0, skipped: 0 };

  if (integration.provider === "confluence") {
    const keys: string[] = Array.isArray(cfg.spaceKeys) ? cfg.spaceKeys : [];
    for (const key of keys) {
      const r = await confluenceService.syncSpace(integration, key);
      counts.imported += r.imported; counts.updated += r.updated; counts.skipped += r.skipped;
    }
  } else if (integration.provider === "google_drive") {
    const fileIds: string[] = Array.isArray(cfg.fileIds) ? cfg.fileIds : [];
    if (fileIds.length) {
      const r = await googleDriveService.syncFiles(integration, fileIds);
      counts.imported += r.imported; counts.updated += r.updated; counts.skipped += r.skipped;
    }
  }
  return counts;
}

/** One scheduler tick: refresh every eligible integration. */
async function runSyncTick(): Promise<void> {
  const integrations = await prisma.knowledgeIntegration.findMany({ where: { isActive: true } });
  let checked = 0;
  for (const integration of integrations) {
    const cfg = (integration.config && typeof integration.config === "object" ? integration.config : {}) as any;
    if (cfg.autoSync === false) continue;                 // explicitly disabled by the admin
    const hasSelection =
      (Array.isArray(cfg.spaceKeys) && cfg.spaceKeys.length > 0) ||
      (Array.isArray(cfg.fileIds) && cfg.fileIds.length > 0);
    if (!hasSelection) continue;                           // never synced manually → nothing to refresh

    checked++;
    try {
      const r = await reSyncIntegration(integration);
      if (r.imported || r.updated) {
        console.log(`[knowledge-sync] ${integration.provider} ${integration.id}: +${r.imported} ~${r.updated} (=${r.skipped} unchanged)`);
      }
    } catch (err: any) {
      console.error(`[knowledge-sync] integration ${integration.id} failed:`, err?.message);
    }
  }
  if (checked > 0) console.log(`[knowledge-sync] tick complete - ${checked} integration(s) checked`);
}

let _started = false;
export async function startKnowledgeSyncScheduler(): Promise<void> {
  if (_started) return;
  _started = true;

  // Repeatable tick. BullMQ dedupes by the repeat key, so restarts / extra
  // instances don't stack duplicate schedules.
  await knowledgeSyncQueue
    .add(
      "sync-tick",
      { type: "sync_tick" },
      { repeat: { pattern: SYNC_CRON }, removeOnComplete: { count: 10 }, removeOnFail: { count: 20 } },
    )
    .catch((err) => console.error("[knowledge-sync] failed to schedule tick:", err?.message));

  // createWorker wraps the processor in withCrossTenantAccess - this job
  // legitimately spans tenants (the connectors write rows with explicit
  // tenantId). Concurrency 1: one tick at a time is plenty.
  createWorker(QUEUE_NAME, async () => { await runSyncTick(); }, 1);

  console.log(`[knowledge-sync] scheduler started (cron="${SYNC_CRON}")`);
}
