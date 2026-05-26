/**
 * Tool usage policy skill.
 *
 * Mirrors `buildToolsPolicy()` + `renderToolPolicyHeader()` in
 * `prompt-builder.service.ts:907-964`. Tells the model HOW to use the
 * tools it has been given — when to call vs. when to ask — varying by
 * mode (autonomous executes, copilot proposes, callpilot triggers
 * minimal action).
 *
 * The tool LIST itself is rendered separately by the OpenAI client at
 * the `tools:` parameter level (not in the system prompt). This skill
 * only renders the POLICY language.
 */

import { defineSkill } from "../registry";

defineSkill({
  id: "tool_usage_policy",
  kind: "execution",
  name: "Tool Usage Policy",
  version: "1.0.0",
  toolsAdded: [],
  toolsRequired: [],
  render: (ctx) => {
    const lines: string[] = [];
    lines.push("# Tool Usage");

    if (ctx.mode === "autonomous") {
      lines.push(
        "You may call any tool the platform has granted you. Call tools when an action is the right next step — do not narrate intent without acting.",
      );
      lines.push("");
      lines.push("Rules:");
      lines.push("- Verify required parameters before calling. If the customer didn't supply a value (time, amount, recipient), ASK — do not invent.");
      lines.push("- Never call a write tool more than once per turn unless explicitly told to retry.");
      lines.push("- After a tool returns, summarize the outcome for the customer in their language.");
    } else if (ctx.mode === "copilot") {
      lines.push(
        "You assist a human rep. Tools are PROPOSALS the human approves — never execute closure or follow-up scheduling on your own.",
      );
      lines.push("");
      lines.push("Rules:");
      lines.push("- Suggest a tool call by naming the tool and the exact arguments you'd pass.");
      lines.push("- Wait for the human to confirm before assuming the action happened.");
      lines.push("- If the human asks you to draft a customer reply, write it in the customer's language — do not call send_message.");
    } else if (ctx.mode === "callpilot") {
      lines.push(
        "Real-time call. Tools available to you during the call are minimal — most actions are deferred to post-call.",
      );
      lines.push("");
      lines.push("Rules:");
      lines.push("- Do not call write tools mid-call unless explicitly enabled.");
      lines.push("- Surface action triggers as structured cues; the post-call worker executes them.");
    }

    return lines.join("\n");
  },
});
