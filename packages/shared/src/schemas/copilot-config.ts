import { z } from "zod";

/**
 * Per-channel Live Call Copilot configuration.
 *
 * Stored on `voice_channels.copilot_config` (JSONB) and merged into the
 * LivePromptAssembler so every voice channel can carry its own goals,
 * required questions, data-collection fields, persona, and output language.
 *
 * Empty `{}` means "use platform defaults" - every field is optional so we
 * can introduce new dimensions without migrating existing rows.
 */
export const CopilotQuestionSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  required: z.boolean().default(false),
});
export type CopilotQuestion = z.infer<typeof CopilotQuestionSchema>;

export const CopilotDataFieldSchema = z.object({
  field: z.string().min(1),       // e.g. "email", "company_size"
  label: z.string().min(1),       // rep-facing label
  required: z.boolean().default(false),
});
export type CopilotDataField = z.infer<typeof CopilotDataFieldSchema>;

export const CopilotConfigSchema = z.object({
  /** BCP-47 short code: "he", "en", … . Falls back to tenant locale. */
  language: z.string().optional(),
  /** Short persona/tone descriptor surfaced to the LLM. */
  persona: z.string().optional(),
  /**
   * Free-text objective(s) for the call. DEPRECATED in favor of per-stage
   * goals defined on TenantFunnel.stages[].copilot.goal. Still honored as a
   * fallback when no stage-specific goal is resolved (new contact, no funnel).
   */
  goals: z.string().optional(),
  /** Questions the rep MUST ask. */
  questions: z.array(CopilotQuestionSchema).default([]),
  /** Structured fields the call MUST collect (drives missingFields cues). */
  dataFields: z.array(CopilotDataFieldSchema).default([]),
  /**
   * Per-channel funnel override. When set, calls answered on this voice
   * channel use this specific TenantFunnel for stage resolution - taking
   * precedence over the department-scoped funnel lookup. Lets a tenant
   * run different funnels per phone number (e.g. inbound sales vs.
   * inbound support) without splitting departments. Stores the
   * TenantFunnel.id (cuid), not the human funnelId.
   */
  funnelId: z.string().optional(),
  /**
   * AI Employee assigned to this voice channel. Today stored on the
   * JSONB blob as a forward-compatible bridge; Phase 6 migrates it
   * into a real FK column on `voice_channels.ai_agent_id`. The
   * backfill script reads this field first so populating it via the
   * UI now is the safe early move.
   *
   * The unified worker's `workerConfigFromAgent()` shim reads the
   * referenced AIAgent so the SAME employee that runs the tenant's
   * chat / copilot turns also drives call-pilot. The call-pilot
   * skill layer is added at runtime via `mode='callpilot'` - no
   * separate config blob.
   */
  aiAgentId: z.string().optional(),
});
export type CopilotConfig = z.infer<typeof CopilotConfigSchema>;

/** Empty config - used when a channel has no override. */
export const EMPTY_COPILOT_CONFIG: CopilotConfig = {
  questions: [],
  dataFields: [],
};

/**
 * Best-effort parse of an unknown JSON blob from `voice_channels.copilot_config`.
 * Returns the empty config on any validation failure so a malformed row
 * never blocks the call.
 */
export function parseCopilotConfig(raw: unknown): CopilotConfig {
  const parsed = CopilotConfigSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : EMPTY_COPILOT_CONFIG;
}

// ─── Per-stage copilot config (funnel-driven) ────────────────────

/**
 * Exit criteria for a pipeline stage. The post-call summarizer evaluates
 * the LIVE transcript against these and produces a confidence score that
 * drives `stage_transition_suggestion`.
 */
export const StageExitCriteriaSchema = z.object({
  /** crm_patch keys that MUST be populated by end of call (e.g. ["budget","timeline"]). */
  mustHaveFields: z.array(z.string()).default([]),
  /** Required-question ids/texts that MUST have been asked + answered. */
  mustAskQuestions: z.array(z.string()).default([]),
  /** Short marker phrases that indicate the criterion is satisfied. */
  positiveSignals: z.array(z.string()).default([]),
  /** Marker phrases that block the transition (e.g. "not interested"). */
  negativeSignals: z.array(z.string()).default([]),
});
export type StageExitCriteria = z.infer<typeof StageExitCriteriaSchema>;

/**
 * Stage-scoped copilot configuration. Lives at
 * TenantFunnel.stages[i].copilot. When a stage carries this block, the
 * live cue projector and post-call summarizer prefer it over the
 * channel-level config (which becomes the fallback).
 */
export const StageCopilotConfigSchema = z.object({
  /** What the rep should achieve in this stage. Replaces channel `goals`. */
  goal: z.string().optional(),
  /** Stage-specific questions the rep MUST ask. */
  requiredQuestions: z.array(CopilotQuestionSchema).default([]),
  /** Stage-specific data fields the rep MUST collect. */
  requiredDataFields: z.array(CopilotDataFieldSchema).default([]),
  /** Exit/success criteria. Drives the auto-advance decision post-call. */
  exitCriteria: StageExitCriteriaSchema.optional(),
  /** Stage id to advance to once exit criteria are met. */
  nextStageId: z.string().optional(),
});
export type StageCopilotConfig = z.infer<typeof StageCopilotConfigSchema>;

export const EMPTY_STAGE_COPILOT_CONFIG: StageCopilotConfig = {
  requiredQuestions: [],
  requiredDataFields: [],
};

export function parseStageCopilotConfig(raw: unknown): StageCopilotConfig {
  const parsed = StageCopilotConfigSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : EMPTY_STAGE_COPILOT_CONFIG;
}
