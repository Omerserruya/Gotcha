import type { TranscriptUtterance, CopilotConfig } from "@chatcenter/shared";
import {
  liveBehaviorContract,
  outputSchemaBlock,
  orgInstructionsBlock,
  playbookStageBlock,
  type PlaybookStageContext,
  crmContextBlock,
  type CrmSnapshot,
  transcriptFenceBlock,
  copilotConfigBlock,
} from "./blocks";

/**
 * Builds the message array for the Live Call Copilot's main-turn LLM call.
 *
 * Layered per the architecture document, with prefix-cacheable blocks
 * grouped at the front:
 *
 *   L0 system: orgInstructions          (cached prefix)
 *   L1 system: playbookStage            (cached per stage)
 *   L2 system: crmContext               (cached per call, short TTL)
 *   L3 system: liveBehaviorContract     (cached prefix)
 *   L4 system: outputSchema             (cached prefix)
 *   L5 system: rollingSummary           (Tier B; updated every 30s)
 *   L6 user:   <transcript>fenced Tier A (last N)</transcript>
 *
 * Output is a single chat-completions message array. The runner passes it
 * to ai.service.generateResponse with response_format: { type: "json_object" }.
 * Phase 3 ships JSON mode; a future polish pass can switch to strict
 * json_schema mode without changing this assembler.
 */

export interface LivePromptInput {
  /** Tier B summary text. Empty string when no rolling summary yet. */
  rollingSummary: string;
  /** Last N utterances (Tier A window) — already trimmed by ConversationMemory. */
  recentUtterances: TranscriptUtterance[];
  /** Org-level instructions (defaults provided by the block). */
  org?: { identity?: string; tone?: string; forbidden?: string[] };
  /** Playbook stage context (may be unset if no playbook configured). */
  playbookStage?: PlaybookStageContext;
  /** CRM snapshot (may be unset if no CRM data fetched). */
  crm?: CrmSnapshot;
  /**
   * Per-channel copilot config (language, persona, goals, required
   * questions, data fields). When supplied, the assembler emits an
   * additional system block right after orgInstructions so channel
   * overrides win over platform defaults.
   */
  copilotConfig?: CopilotConfig;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export class LivePromptAssembler {
  /**
   * Assemble the full message array. No imports across assemblers — only
   * shared blocks (anti-duplication rule #2).
   */
  build(input: LivePromptInput): ChatMessage[] {
    const messages: ChatMessage[] = [
      { role: "system", content: orgInstructionsBlock(input.org) },
    ];

    // Channel-level copilot config (language, goals, required Qs, …).
    // Skipped when not configured — the block returns "" in that case.
    const copilotBlock = copilotConfigBlock(input.copilotConfig);
    if (copilotBlock) {
      messages.push({ role: "system", content: copilotBlock });
    }

    messages.push(
      { role: "system", content: playbookStageBlock(input.playbookStage) },
      { role: "system", content: crmContextBlock(input.crm) },
      { role: "system", content: liveBehaviorContract() },
      { role: "system", content: outputSchemaBlock() },
    );

    if (input.rollingSummary && input.rollingSummary.trim().length > 0) {
      messages.push({
        role: "system",
        content: `ROLLING SUMMARY (everything before the recent window):\n${input.rollingSummary}`,
      });
    }

    const fenced = transcriptFenceBlock(input.recentUtterances);
    messages.push({
      role: "user",
      content: `<transcript>\n${fenced}\n</transcript>`,
    });

    return messages;
  }
}
