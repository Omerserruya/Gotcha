import { randomUUID } from "crypto";
import { readDurableSetting, writeDurableSetting } from "@chatcenter/shared";

/**
 * Is an AI employee's readiness report being made right now (H7, 2026-10-13)?
 *
 * The report runs in the background after a hire and on the manual button, and
 * takes about a minute. The page used to guess ("checking for 3 minutes"); it
 * now reads the truth: running, done, or failed with the reason.
 *
 * Stored as TenantSetting "agent:readiness:<aiAgentId>" (no migration):
 * { runId, status, startedAt, finishedAt?, error? }.
 * - Each run has its own runId and only that run may finish it, so a second run
 *   started meanwhile is not marked done by the first one ending.
 * - A run still "running" after STALE_AFTER_MS died with its process: it reads
 *   as failed "timed_out" rather than spinning forever.
 * Status writes never fail the run: a missed write only costs the indicator.
 */
export type ReadinessState = "running" | "done" | "failed";

export interface ReadinessStatus {
  status: ReadinessState;
  startedAt: string;
  finishedAt: string | null;
  /** The failure's code (e.g. "agent_not_found", "timed_out"); null unless failed. */
  error: string | null;
}

interface Stored extends ReadinessStatus {
  runId: string;
}

export const STALE_AFTER_MS = 10 * 60 * 1000;

export function readinessStatusKey(aiAgentId: string): string {
  return `agent:readiness:${aiAgentId}`;
}

async function readStored(tenantId: string, aiAgentId: string): Promise<Stored | null> {
  try {
    const raw = await readDurableSetting(tenantId, readinessStatusKey(aiAgentId));
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!v || (v.status !== "running" && v.status !== "done" && v.status !== "failed") || typeof v.startedAt !== "string") return null;
    return v as Stored;
  } catch {
    return null;
  }
}

async function write(tenantId: string, aiAgentId: string, value: Stored): Promise<void> {
  try {
    await writeDurableSetting(tenantId, readinessStatusKey(aiAgentId), JSON.stringify(value), "readiness");
  } catch (err: any) {
    console.warn(`[readiness] status write failed for ${aiAgentId}:`, err?.message);
  }
}

/** Mark a run as started. Returns its runId, which finishing it needs. */
export async function markReadinessRunning(tenantId: string, aiAgentId: string, now: Date = new Date()): Promise<string> {
  const runId = randomUUID();
  await write(tenantId, aiAgentId, { runId, status: "running", startedAt: now.toISOString(), finishedAt: null, error: null });
  return runId;
}

/** Finish a run, unless a newer run has started since. */
export async function markReadinessFinished(
  tenantId: string,
  aiAgentId: string,
  runId: string,
  outcome: { ok: true } | { ok: false; error: string },
  now: Date = new Date(),
): Promise<void> {
  const current = await readStored(tenantId, aiAgentId);
  if (current && current.runId !== runId) return;
  await write(tenantId, aiAgentId, {
    runId,
    status: outcome.ok ? "done" : "failed",
    startedAt: current?.startedAt ?? now.toISOString(),
    finishedAt: now.toISOString(),
    error: outcome.ok ? null : outcome.error,
  });
}

/** The status to show, or null when no run was ever recorded. */
export async function readReadinessStatus(tenantId: string, aiAgentId: string, now: Date = new Date()): Promise<ReadinessStatus | null> {
  const s = await readStored(tenantId, aiAgentId);
  if (!s) return null;
  if (s.status === "running" && now.getTime() - Date.parse(s.startedAt) > STALE_AFTER_MS) {
    return { status: "failed", startedAt: s.startedAt, finishedAt: null, error: "timed_out" };
  }
  return { status: s.status, startedAt: s.startedAt, finishedAt: s.finishedAt ?? null, error: s.error ?? null };
}
