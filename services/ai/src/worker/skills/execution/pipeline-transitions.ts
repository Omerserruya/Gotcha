/**
 * Pipeline transition skill.
 *
 * Encodes the funnel-progression contract: what each stage's exit
 * criteria mean, when to advance, and how to surface progress.
 *
 * Reads `ctx.pipeline` (frozen session-start snapshot from the funnel
 * resolver). When the worker has no funnel attached, this skill renders
 * nothing — clean drop, no orphan section header.
 *
 * Authoritative source for stage data: TenantFunnel.stages[].copilot
 * via `stage-resolver.service.ts`.
 */

import { defineSkill } from "../registry";

defineSkill({
  id: "pipeline_transitions",
  kind: "execution",
  name: "Pipeline Transitions",
  version: "1.0.0",
  toolsAdded: [],
  toolsRequired: [],
  render: (ctx) => {
    const p = ctx.pipeline;
    if (!p?.currentStageId) return "";

    const lines: string[] = [];
    lines.push("# Pipeline");
    lines.push(`Current stage: **${p.currentStageLabel ?? p.currentStageId}**`);
    if (p.nextStageLabel || p.nextStageId) {
      lines.push(`Next stage: **${p.nextStageLabel ?? p.nextStageId}**`);
    }
    lines.push("");
    lines.push(
      "Your job in this stage: drive the conversation toward the exit criteria. When the criteria are met, the post-call worker advances the funnel — you don't call a tool to transition.",
    );

    if (ctx.mode === "callpilot") {
      lines.push("");
      lines.push("Surface to the rep: how close we are to exit criteria, in one line.");
    }

    return lines.join("\n");
  },
});
