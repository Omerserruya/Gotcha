import { z } from "zod";

/**
 * AI Worker — unified configuration for chat, co-pilot, call-pilot, and
 * autonomous-bot AI execution.
 *
 * Replaces the per-mode prompt assemblers (LivePromptAssembler,
 * buildAgentPrompt) and the per-channel configs (AIAgent + CopilotConfig).
 *
 * Cache contract: every worker instance is bound to a `sessionId`. The
 * prompt assembled from a worker MUST be byte-stable for its sessionId so
 * OpenAI's automatic prefix cache hits on every turn after the first.
 *
 * Phase 0: types only. No runtime behavior yet — call sites still use the
 * legacy assemblers. Phase 4 introduces the session registry that holds
 * live worker instances.
 */

// ─── Mode ───────────────────────────────────────────────────────

export const AIWorkerModeSchema = z.enum(["autonomous", "copilot", "callpilot"]);
export type AIWorkerMode = z.infer<typeof AIWorkerModeSchema>;

// ─── Skills ─────────────────────────────────────────────────────

export const AISkillKindSchema = z.enum(["operational", "language", "execution"]);
export type AISkillKind = z.infer<typeof AISkillKindSchema>;

/**
 * A skill is a composable prompt fragment + tool/guardrail metadata.
 * Skills are pure functions of (workerContext) -> string; their output is
 * concatenated into SYSTEM_CORE in a deterministic order so the resulting
 * bytes are stable per session.
 */
export const AISkillSchema = z.object({
  id: z.string().min(1),
  kind: AISkillKindSchema,
  /** Human-readable identifier; not surfaced to the LLM directly. */
  name: z.string().min(1),
  /** Bumped when content changes — invalidates session caches keyed on hash. */
  version: z.string().min(1),
  /** The prompt fragment this skill injects into SYSTEM_CORE. */
  content: z.string(),
  /** Tools this skill GRANTS (added to the worker's tool allowlist). */
  toolsAdded: z.array(z.string()).default([]),
  /** Tools this skill DEPENDS ON (validation error if absent at compose time). */
  toolsRequired: z.array(z.string()).default([]),
});
export type AISkill = z.infer<typeof AISkillSchema>;

// ─── Identity ───────────────────────────────────────────────────

export const AIWorkerIdentitySchema = z.object({
  name: z.string().min(1),
  persona: z.string().optional(),
  /** BCP-47 short code. Falls back to tenant locale. */
  language: z.string().optional(),
});
export type AIWorkerIdentity = z.infer<typeof AIWorkerIdentitySchema>;

// ─── Guardrails ─────────────────────────────────────────────────

export const AIWorkerGuardrailsSchema = z.object({
  blockedTopics: z.array(z.string()).default([]),
  escalationKeywords: z.array(z.string()).default([]),
  maxDiscountPercent: z.number().min(0).max(100).optional(),
  refundRequiresApproval: z.boolean().default(true),
  customRules: z.array(z.string()).default([]),
});
export type AIWorkerGuardrails = z.infer<typeof AIWorkerGuardrailsSchema>;

// ─── Worker Config (persisted) ──────────────────────────────────

/**
 * Persisted shape of an AI Worker. Stored on the (forthcoming) AIWorker
 * Prisma model. Replaces AIAgent.
 *
 * Note: `description` is intentionally absent — it was the legacy
 * human-authored summary field on AIAgent. Per refactor brief, descriptions
 * are LLM-generated on demand or inferred from the worker config registry.
 */
export const AIWorkerConfigSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  identity: AIWorkerIdentitySchema,
  /** Default mode for this worker. Per-call override via session context. */
  mode: AIWorkerModeSchema,
  /** Ordered list of skill IDs to compose into SYSTEM_CORE. */
  skillIds: z.array(z.string()).default([]),
  /** TenantFunnel id — pipeline source of truth. Nullable for non-funnel workers. */
  funnelId: z.string().nullable().default(null),
  guardrails: AIWorkerGuardrailsSchema,
  /** Knowledge base ids the worker may retrieve from (via search_kb tool). */
  knowledgeBaseIds: z.array(z.string()).default([]),
  /** Free-form bag for forward-compat. Not injected into prompt. */
  metadata: z.record(z.unknown()).default({}),
  isActive: z.boolean().default(true),
});
export type AIWorkerConfig = z.infer<typeof AIWorkerConfigSchema>;

// ─── Session Profile (frozen at session start) ──────────────────

/**
 * Snapshot of customer/conversation context captured ONCE at session start.
 * Injected as the SECOND system message — stable bytes for the session's
 * lifetime so it joins the cached prefix.
 *
 * Late-breaking updates (new CRM data, fresh KB hits) must NOT mutate this
 * — they flow in via tool-result messages instead.
 */
export const AIWorkerSessionProfileSchema = z.object({
  sessionId: z.string().min(1),
  conversationId: z.string().optional(),
  contactId: z.string().optional(),
  customer: z
    .object({
      name: z.string().optional(),
      externalId: z.string().optional(),
      email: z.string().optional(),
      phone: z.string().optional(),
      channel: z.string().optional(),
    })
    .default({}),
  pipeline: z
    .object({
      funnelId: z.string().optional(),
      currentStageId: z.string().optional(),
      currentStageLabel: z.string().optional(),
      nextStageId: z.string().optional(),
      nextStageLabel: z.string().optional(),
    })
    .default({}),
  /** Frozen BEL output at session start. No per-turn recomputation. */
  behavior: z
    .object({
      toneIntensity: z.number().optional(),
      allowedActions: z.array(z.string()).optional(),
      outputContractKey: z.string().optional(),
    })
    .default({}),
  /** ISO timestamp of when the snapshot was taken. Logged, never in prompt. */
  capturedAt: z.string(),
});
export type AIWorkerSessionProfile = z.infer<typeof AIWorkerSessionProfileSchema>;

// ─── Cache Validation ───────────────────────────────────────────

/**
 * Result of hashing SYSTEM_CORE + SESSION_PROFILE. Logged with every
 * AI call so we can detect prefix drift within a session.
 *
 * Invariant: for a given sessionId, `hash` MUST be constant across calls.
 * Violation = OpenAI prefix cache invalidated; in dev we throw, in prod we
 * log + alert.
 */
export interface AIWorkerPromptFingerprint {
  hash: string;
  systemCoreBytes: number;
  sessionProfileBytes: number;
}
