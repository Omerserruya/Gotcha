/**
 * In-memory registry of live AI Worker sessions.
 *
 * One entry per `sessionId` (conversation/call). Holds the FROZEN
 * SYSTEM_CORE + SESSION_PROFILE strings + their fingerprint. The
 * worker's `generate()` method reads from here so the same bytes are
 * sent to OpenAI for every call in the session - which is what makes
 * the prefix cache hit.
 *
 * Lifecycle:
 *   - `getOrCreate(args)` resolves the worker config, snapshots the
 *     pipeline + customer profile, composes SYSTEM_CORE, fingerprints,
 *     and inserts. Subsequent calls return the same entry.
 *   - `release(sessionId)` evicts the entry when the conversation ends.
 *     If a caller forgets to release, GC kicks in at MAX_TRACKED_SESSIONS.
 *
 * This is intentionally process-local. The fingerprint check works
 * across processes too because both processes will recompute the same
 * bytes from the same DB state.
 */

import type {
  AIWorkerConfig,
  AIWorkerSessionProfile,
} from "@chatcenter/shared";
import type { AIWorkerMode } from "@chatcenter/shared";
import type { SkillRenderContext } from "./types";
import { buildSystemCore, type BuildSystemCoreOutput } from "./prompt/system-core-builder";
import { buildSessionProfile } from "./prompt/session-profile-builder";
import { fingerprintPrefix, recordPrefixFingerprint, assertPrefixStability } from "./observability/prompt-hash";

const MAX_TRACKED_SESSIONS = 1000;

export interface WorkerSession {
  sessionId: string;
  worker: AIWorkerConfig;
  mode: AIWorkerMode;
  profile: AIWorkerSessionProfile;
  systemCore: string;
  sessionProfileText: string;
  fingerprint: { hash: string; systemCoreBytes: number; sessionProfileBytes: number };
  /** Diagnostics from the skill composer. */
  skillIds: string[];
  missingSkillIds: string[];
  skillToolsAdded: string[];
  skillToolsRequired: string[];
  capturedAt: string;
}

export interface OpenSessionArgs {
  sessionId: string;
  worker: AIWorkerConfig;
  /** Override worker.mode if the call site is mode-specific. */
  mode?: AIWorkerMode;
  profile: AIWorkerSessionProfile;
  locale?: string;
}

const REGISTRY = new Map<string, WorkerSession>();

export function getOrCreateSession(args: OpenSessionArgs): WorkerSession {
  const existing = REGISTRY.get(args.sessionId);
  if (existing) return existing;

  // Evict oldest entries if at capacity.
  if (REGISTRY.size >= MAX_TRACKED_SESSIONS) {
    const drop = Math.floor(MAX_TRACKED_SESSIONS / 2);
    let i = 0;
    for (const k of REGISTRY.keys()) {
      if (i++ >= drop) break;
      REGISTRY.delete(k);
    }
  }

  const mode = args.mode ?? args.worker.mode;
  const ctx: SkillRenderContext = {
    mode,
    identity: args.worker.identity,
    guardrails: args.worker.guardrails,
    locale: args.locale ?? args.worker.identity.language,
    pipeline: args.profile.pipeline,
  };

  const core: BuildSystemCoreOutput = buildSystemCore({
    worker: args.worker,
    mode,
    ctx,
  });
  const sessionProfileText = buildSessionProfile(args.profile);
  const fingerprint = fingerprintPrefix(core.text, sessionProfileText);

  // Record fingerprint - this is the first call so it should always be
  // firstSeen=true. Calling here makes the registry self-validating.
  const drift = recordPrefixFingerprint(args.sessionId, fingerprint.hash);
  // If somehow a stale fingerprint exists for this sessionId (e.g. a
  // crash recycled the id), the registry would still be empty but the
  // fingerprint map might not be. Surface that condition.
  assertPrefixStability(drift);

  const session: WorkerSession = {
    sessionId: args.sessionId,
    worker: args.worker,
    mode,
    profile: args.profile,
    systemCore: core.text,
    sessionProfileText,
    fingerprint,
    skillIds: core.skillIds,
    missingSkillIds: core.missingSkillIds,
    skillToolsAdded: core.skillToolsAdded,
    skillToolsRequired: core.skillToolsRequired,
    capturedAt: args.profile.capturedAt,
  };
  REGISTRY.set(args.sessionId, session);
  return session;
}

/**
 * Validate that a session's prefix is still stable. Call this on every
 * subsequent turn before sending to OpenAI - drift = bug to fix, not a
 * recoverable runtime condition.
 */
export function verifySessionFingerprint(sessionId: string): void {
  const session = REGISTRY.get(sessionId);
  if (!session) return;
  const next = fingerprintPrefix(session.systemCore, session.sessionProfileText);
  const drift = recordPrefixFingerprint(sessionId, next.hash);
  assertPrefixStability(drift);
}

export function getSession(sessionId: string): WorkerSession | undefined {
  return REGISTRY.get(sessionId);
}

export function releaseSession(sessionId: string): void {
  REGISTRY.delete(sessionId);
}

/** Test-only: clear the registry. Never call from production code. */
export function __clearRegistryForTests(): void {
  REGISTRY.clear();
}
