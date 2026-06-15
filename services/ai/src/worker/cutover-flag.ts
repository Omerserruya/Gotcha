/**
 * USE_UNIFIED_WORKER cutover flag.
 *
 * Each legacy call site reads this to decide whether to route through
 * the unified `AIWorker` or the legacy assembler. Per-site granularity
 * lets us flip them one at a time and watch for regressions.
 *
 * Env var format: comma-separated site keys, or "all", or empty.
 *   USE_UNIFIED_WORKER=""                      → all sites use legacy (default)
 *   USE_UNIFIED_WORKER="callpilot"             → only the live runner uses the worker
 *   USE_UNIFIED_WORKER="callpilot,copilot"     → callpilot + copilot routes
 *   USE_UNIFIED_WORKER="all"                   → every site uses the worker
 *
 * Read on every call (NOT cached) so an ops change to the env var is
 * picked up on the next request without a restart.
 */

export type CutoverSite =
  | "callpilot" // services/ai/src/services/intelligence/live-analysis-runner.ts
  | "copilot" //   services/ai/src/routes/ai-{debug,assist}.ts
  | "autonomous" // services/ai/src/services/ai-bot.service.ts
  | "system_copilot_stream"; // services/ai/src/services/agent-runtime.service.ts

export function isUnifiedWorkerEnabled(site: CutoverSite): boolean {
  const raw = (process.env.USE_UNIFIED_WORKER ?? "").trim().toLowerCase();
  if (!raw) return false;
  if (raw === "all" || raw === "true" || raw === "1") return true;
  const enabled = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return enabled.includes(site);
}

/** Test helper - same behaviour as the env var without env mutation. */
export function isUnifiedWorkerEnabledFor(
  site: CutoverSite,
  rawFlag: string | undefined,
): boolean {
  const v = (rawFlag ?? "").trim().toLowerCase();
  if (!v) return false;
  if (v === "all" || v === "true" || v === "1") return true;
  return v.split(",").map((s) => s.trim()).filter(Boolean).includes(site);
}
