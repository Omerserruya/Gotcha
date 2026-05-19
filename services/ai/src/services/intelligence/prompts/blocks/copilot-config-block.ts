import type { CopilotConfig } from "@chatcenter/shared";

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
 * Renders the per-channel Copilot configuration as a system block.
 *
 * Lives between the org-instructions block and the playbook-stage block so
 * channel-level overrides win over the platform defaults but lose to a
 * configured playbook stage. Returns an empty string when no fields are
 * configured — the assembler filters empty blocks out.
 */
export function copilotConfigBlock(config?: CopilotConfig): string {
  if (!config) return "";

  const parts: string[] = [];

  const langName = formatLanguage(config.language);
  if (langName) {
    parts.push(
      `OUTPUT LANGUAGE: All copilot-facing text (suggestedActions, missingFields.suggestedQuestion, summary, etc.) MUST be written in ${langName}. The transcript itself may be mixed-language; that does NOT change the output language.`,
    );
  }

  if (config.persona && config.persona.trim()) {
    parts.push(`PERSONA: ${config.persona.trim()}`);
  }

  if (config.goals && config.goals.trim()) {
    parts.push(`CALL GOALS: ${config.goals.trim()}`);
  }

  if (config.questions && config.questions.length > 0) {
    const lines = config.questions.map((q, i) => {
      const tag = q.required ? "[required]" : "[optional]";
      return `  ${i + 1}. ${tag} ${q.text}`;
    });
    parts.push(
      `REQUIRED QUESTIONS (the rep should cover these during the call; surface a missingFields entry for any required question still unanswered):\n${lines.join("\n")}`,
    );
  }

  if (config.dataFields && config.dataFields.length > 0) {
    const required = config.dataFields.filter((f) => f.required);
    const optional = config.dataFields.filter((f) => !f.required);
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
  return `CHANNEL COPILOT CONFIG\n${parts.join("\n\n")}`;
}
