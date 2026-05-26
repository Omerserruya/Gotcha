/**
 * Internal worker types. Augments the public schema in
 * `@chatcenter/shared/schemas/ai-worker` with runtime-only types that
 * don't need Zod validation.
 */

import type {
  AIWorkerMode,
  AISkill,
  AISkillKind,
  AIWorkerConfig,
  AIWorkerIdentity,
  AIWorkerGuardrails,
  AIWorkerSessionProfile,
} from "@chatcenter/shared";

export type {
  AIWorkerMode,
  AISkill,
  AISkillKind,
  AIWorkerConfig,
  AIWorkerIdentity,
  AIWorkerGuardrails,
  AIWorkerSessionProfile,
};

/**
 * The context passed to a SkillRenderer at compose time. Stable per
 * session — anything dynamic per turn lives in the message history, NOT
 * in the rendered skill fragment.
 */
export interface SkillRenderContext {
  mode: AIWorkerMode;
  identity: AIWorkerIdentity;
  guardrails: AIWorkerGuardrails;
  /** Locale snapshot at session start. */
  locale?: string;
  /** Frozen pipeline context — funnel/stage. May be null for non-funnel workers. */
  pipeline?: AIWorkerSessionProfile["pipeline"];
}

/**
 * A skill renderer is a pure function from (context) -> string fragment.
 * It MUST be deterministic — same context always yields identical bytes.
 *
 * Skills declared via `defineSkill()` get this signature; the registry
 * composer concatenates fragments in a deterministic order.
 */
export type SkillRenderer = (ctx: SkillRenderContext) => string;

/**
 * Runtime skill registration. Combines the persistable metadata with the
 * renderer function. System skills declare these at module load; custom
 * tenant skills (future) would build them from DB rows.
 */
export interface RegisteredSkill {
  meta: Omit<AISkill, "content">;
  render: SkillRenderer;
}

/**
 * Result of composing a worker's skill set into a prompt fragment.
 * The composer returns this so we can both inject `text` into SYSTEM_CORE
 * and reconcile `toolsRequired` against the worker's actual tool surface.
 */
export interface ComposedSkills {
  text: string;
  toolsAdded: string[];
  toolsRequired: string[];
  /** Ordered skill ids that contributed — useful for observability. */
  skillIds: string[];
}
