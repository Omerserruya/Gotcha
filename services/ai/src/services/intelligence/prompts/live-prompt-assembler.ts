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
  type StageContextForPrompt,
  alreadyAnsweredBlock,
  type AlreadyAnsweredInput,
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
  /** Last N utterances (Tier A window) - already trimmed by ConversationMemory. */
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
  /**
   * Active pipeline stage for THIS customer, resolved at runner-spawn
   * time from the CRM vendor's stage field against the tenant funnel.
   * When present, the stage's copilot block (goal, required Qs/fields,
   * exit criteria) supersedes the channel-level goals during cue
   * generation. Channel `goals` becomes the fallback for unstaged calls.
   */
  stageContext?: StageContextForPrompt;
  /**
   * Per-turn "already answered" hint sheet. Combines CRM-known identifiers
   * (set once at runner spawn) with the cue projector's accumulated
   * observedFilled set (updated every frame). The block instructs the LLM
   * to OMIT any of these from missingFields. Without it, the bot re-asks
   * customers for their name/email/etc. several turns after they answered.
   */
  alreadyAnswered?: AlreadyAnsweredInput;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export class LivePromptAssembler {
  /**
   * Assemble the full message array. No imports across assemblers - only
   * shared blocks (anti-duplication rule #2).
   */
  build(input: LivePromptInput): ChatMessage[] {
    const messages: ChatMessage[] = [
      { role: "system", content: orgInstructionsBlock(input.org) },
    ];

    // Channel-level + stage-level copilot config (language, persona, goal,
    // required Qs, data fields, exit criteria). Stage takes precedence
    // over channel for goal/Qs/fields when both are present. Skipped when
    // neither is configured - the block returns "" in that case.
    const copilotBlock = copilotConfigBlock(input.copilotConfig, input.stageContext);
    if (copilotBlock) {
      messages.push({ role: "system", content: copilotBlock });
    }

    // ALREADY-ANSWERED hint sheet. Rendered AFTER copilotConfigBlock (so the
    // LLM has already seen the field/question list) and BEFORE the
    // behaviorContract - close enough to the schema instructions to act as
    // a binding rule, far enough from the transcript that it's not
    // overshadowed by the live audio.
    const aaBlock = alreadyAnsweredBlock(input.alreadyAnswered);
    if (aaBlock) {
      messages.push({ role: "system", content: aaBlock });
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
