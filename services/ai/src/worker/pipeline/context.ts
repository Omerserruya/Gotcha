/**
 * Unified pipeline context for the AI Worker.
 *
 * Wraps the legacy `stage-resolver.service.ts` so the worker has a single
 * call returning the pipeline snapshot in the shape consumed by
 * `SkillRenderContext` and `AIWorkerSessionProfile["pipeline"]`.
 *
 * Why a wrapper instead of replacing stage-resolver outright in Phase 2a:
 *   - stage-resolver is called from non-worker paths (CRM panel, voice
 *     supervisor) that aren't part of this refactor's blast radius
 *   - keeping the wrapper thin means Phase 6 can delete stage-resolver
 *     atomically once every consumer moves to the worker
 *
 * Determinism contract: the snapshot returned here MUST be stable for
 * the session's lifetime. Late-arriving CRM updates (a rep editing the
 * deal mid-call) do NOT mutate the snapshot - they flow in via a tool
 * result outside the cached prefix.
 */

import type { AIWorkerSessionProfile } from "@chatcenter/shared";
import {
  resolveActiveStage,
  type ResolvedStage,
} from "../../services/intelligence/stage-resolver.service";

export type PipelineSnapshot = AIWorkerSessionProfile["pipeline"];

export interface ResolvePipelineArgs {
  tenantId: string;
  conversationId: string;
  departmentId?: string | null;
}

/**
 * Resolve and freeze the pipeline snapshot for a session.
 *
 * Returns `undefined` when the tenant has no funnel configured - callers
 * should treat that as "no pipeline section" rather than an error. The
 * `pipeline_transitions` skill drops cleanly when the snapshot is absent.
 */
export async function resolvePipelineContext(
  args: ResolvePipelineArgs,
): Promise<PipelineSnapshot | undefined> {
  const resolved = await resolveActiveStage(args);
  if (!resolved) return undefined;
  return Object.freeze(snapshotFromResolved(resolved));
}

/**
 * Pure mapper from the resolver's output to the worker-shaped snapshot.
 * Kept separate so unit tests can exercise it without DB mocks.
 */
export function snapshotFromResolved(resolved: ResolvedStage): PipelineSnapshot {
  return {
    funnelId: resolved.funnel.funnelId,
    currentStageId: resolved.stage.id,
    currentStageLabel: resolved.stage.label,
    nextStageId: resolved.nextStage?.id,
    nextStageLabel: resolved.nextStage?.label,
  };
}

/**
 * Diagnostic source label - useful for observability dashboards to
 * track how often we fall back to first-stage vs match a vendor value.
 * Not part of the prompt; logged with the session profile.
 */
export function describePipelineSource(resolved: ResolvedStage | null): string {
  if (!resolved) return "no-funnel";
  return resolved.source;
}
