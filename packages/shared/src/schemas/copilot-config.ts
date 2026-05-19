import { z } from "zod";

/**
 * Per-channel Live Call Copilot configuration.
 *
 * Stored on `voice_channels.copilot_config` (JSONB) and merged into the
 * LivePromptAssembler so every voice channel can carry its own goals,
 * required questions, data-collection fields, persona, and output language.
 *
 * Empty `{}` means "use platform defaults" — every field is optional so we
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
  /** Free-text objective(s) for the call. */
  goals: z.string().optional(),
  /** Questions the rep MUST ask. */
  questions: z.array(CopilotQuestionSchema).default([]),
  /** Structured fields the call MUST collect (drives missingFields cues). */
  dataFields: z.array(CopilotDataFieldSchema).default([]),
});
export type CopilotConfig = z.infer<typeof CopilotConfigSchema>;

/** Empty config — used when a channel has no override. */
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
