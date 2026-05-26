import type { CopilotConfig, StageCopilotConfig } from "@chatcenter/shared";

const LANGUAGE_NAMES: Record<string, string> = {
  he: "Hebrew",
  en: "English",
  ar: "Arabic",
  ru: "Russian",
  es: "Spanish",
  fr: "French",
};

function formatLanguage(code: string | undefined): string | null {
  if (!code) return null;
  const lower = code.toLowerCase();
  return LANGUAGE_NAMES[lower] ?? code;
}

/**
 * Renders the per-channel + per-stage Copilot configuration as a system
 * block.
 *
 * Layering rules (most specific wins):
 *   - language, persona      → channel-level (stages don't have these).
 *   - goal                   → stage.copilot.goal first, then channel.goals.
 *   - required questions     → MERGED stage + channel; stage flagged STAGE,
 *                              channel flagged CHANNEL. Duplicates are
 *                              de-duped by trimmed lowercase text.
 *   - required data fields   → MERGED the same way (stage > channel on key
 *                              collision).
 *   - exit criteria          → stage-only.
 *
 * Returns an empty string when both config + stage are empty so the
 * assembler filters it out.
 */
export interface StageContextForPrompt {
  /** Tenant-facing stage label (shown in CRM, dashboards). */
  label: string;
  /** Stage identifier — included so the LLM can reference it in evidence. */
  id: string;
  /** Optional next stage to advance to; surfaced so the LLM aims forward. */
  nextLabel?: string | null;
  /** Stage-specific copilot config block. */
  copilot?: StageCopilotConfig;
}

export function copilotConfigBlock(
  config?: CopilotConfig,
  stage?: StageContextForPrompt,
): string {
  if (!config && !stage) return "";

  const parts: string[] = [];

  // Language + persona — channel-level only.
  const langName = formatLanguage(config?.language);
  if (langName) {
    parts.push(
      `OUTPUT LANGUAGE: All copilot-facing text (suggestedActions, missingFields.suggestedQuestion, summary, etc.) MUST be written in ${langName}. The transcript itself may be mixed-language; that does NOT change the output language.`,
    );
  }

  if (config?.persona && config.persona.trim()) {
    parts.push(`PERSONA: ${config.persona.trim()}`);
  }

  // ── Stage context — when present, becomes the spine of this block ──
  if (stage) {
    const lines: string[] = [
      `ACTIVE PIPELINE STAGE: ${stage.label} (${stage.id})`,
    ];
    if (stage.nextLabel) {
      lines.push(
        `NEXT STAGE: ${stage.nextLabel} — every cue/suggestion should move the conversation toward advancing here.`,
      );
    }
    if (stage.copilot?.goal && stage.copilot.goal.trim()) {
      lines.push(`STAGE GOAL: ${stage.copilot.goal.trim()}`);
    }
    const exit = stage.copilot?.exitCriteria;
    if (exit) {
      const exitParts: string[] = [];
      if (exit.mustHaveFields && exit.mustHaveFields.length > 0) {
        exitParts.push(`  data fields collected: ${exit.mustHaveFields.join(", ")}`);
      }
      if (exit.mustAskQuestions && exit.mustAskQuestions.length > 0) {
        exitParts.push(`  questions answered: ${exit.mustAskQuestions.join(" | ")}`);
      }
      if (exit.positiveSignals && exit.positiveSignals.length > 0) {
        exitParts.push(`  positive signals heard (any-of): ${exit.positiveSignals.join(" | ")}`);
      }
      if (exit.negativeSignals && exit.negativeSignals.length > 0) {
        exitParts.push(`  BLOCKED if heard (any-of): ${exit.negativeSignals.join(" | ")}`);
      }
      if (exitParts.length > 0) {
        lines.push(`STAGE EXIT CRITERIA (advance only when these are met):\n${exitParts.join("\n")}`);
      }
    }
    parts.push(lines.join("\n"));
  } else if (config?.goals && config.goals.trim()) {
    // No stage active — fall back to channel-level goals.
    parts.push(`CALL GOALS: ${config.goals.trim()}`);
  }

  // ── Required questions: stage + channel merged ──
  const stageQuestions = stage?.copilot?.requiredQuestions ?? [];
  const channelQuestions = config?.questions ?? [];
  const mergedQuestions = mergeQuestions(stageQuestions, channelQuestions);
  if (mergedQuestions.length > 0) {
    const lines = mergedQuestions.map((q, i) => {
      const tag = q.required ? "[required]" : "[optional]";
      const scope = q.source === "stage" ? "{stage}" : "{channel}";
      return `  ${i + 1}. ${tag} ${scope} ${q.text}`;
    });
    parts.push(
      `REQUIRED QUESTIONS (the rep should cover these during the call; surface a missingFields entry for any required question still unanswered):\n${lines.join("\n")}`,
    );
  }

  // ── Required data fields: stage + channel merged ──
  const stageFields = stage?.copilot?.requiredDataFields ?? [];
  const channelFields = config?.dataFields ?? [];
  const mergedFields = mergeDataFields(stageFields, channelFields);
  if (mergedFields.length > 0) {
    const required = mergedFields.filter((f) => f.required);
    const optional = mergedFields.filter((f) => !f.required);
    const lines: string[] = [];
    if (required.length > 0) {
      lines.push(
        `  required: ${required.map((f) => `${f.field} (${f.label})`).join(", ")}`,
      );
    }
    if (optional.length > 0) {
      lines.push(
        `  optional: ${optional.map((f) => `${f.field} (${f.label})`).join(", ")}`,
      );
    }
    parts.push(
      `DATA FIELDS TO COLLECT (emit a missingFields entry with the field key when unfilled; mark required=true to make the cue blocking):\n${lines.join("\n")}`,
    );
  }

  if (parts.length === 0) return "";
  const header = stage ? "STAGE-AWARE COPILOT CONFIG" : "CHANNEL COPILOT CONFIG";
  return `${header}\n${parts.join("\n\n")}`;
}

interface MergedQuestion {
  id: string;
  text: string;
  required: boolean;
  source: "stage" | "channel";
}

function mergeQuestions(
  stage: Array<{ id: string; text: string; required?: boolean }>,
  channel: Array<{ id: string; text: string; required?: boolean }>,
): MergedQuestion[] {
  const seen = new Set<string>();
  const out: MergedQuestion[] = [];
  for (const q of stage) {
    const key = q.text.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ id: q.id, text: q.text, required: !!q.required, source: "stage" });
  }
  for (const q of channel) {
    const key = q.text.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ id: q.id, text: q.text, required: !!q.required, source: "channel" });
  }
  return out;
}

interface MergedField {
  field: string;
  label: string;
  required: boolean;
  source: "stage" | "channel";
}

function mergeDataFields(
  stage: Array<{ field: string; label: string; required?: boolean }>,
  channel: Array<{ field: string; label: string; required?: boolean }>,
): MergedField[] {
  const seen = new Set<string>();
  const out: MergedField[] = [];
  for (const f of stage) {
    const key = f.field.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ field: f.field, label: f.label, required: !!f.required, source: "stage" });
  }
  for (const f of channel) {
    const key = f.field.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ field: f.field, label: f.label, required: !!f.required, source: "channel" });
  }
  return out;
}
