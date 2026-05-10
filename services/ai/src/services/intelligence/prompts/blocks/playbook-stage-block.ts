/**
 * Playbook stage block.
 *
 * Phase 3 ships a stub that emits a placeholder when no active playbook is
 * loaded. The CallPlaybook + CallPlaybookStage models exist (Phase 2) and
 * can be queried by tenant; concrete loading + stage classification lands
 * when tenants author playbooks. Until then this block degrades gracefully.
 */
export interface PlaybookStageContext {
  playbookId?: string;
  playbookName?: string;
  currentStageId?: string;
  currentStageName?: string;
  currentStageDescription?: string;
  currentStageExitCriteria?: string;
  /** Tenant-authored hints injected verbatim (max 250 tokens recommended). */
  currentStagePrompts?: string;
}

export function playbookStageBlock(ctx?: PlaybookStageContext): string {
  if (!ctx || !ctx.currentStageId) {
    return `ACTIVE PLAYBOOK STAGE: none configured. Behave as a neutral
discovery-stage assistant: surface intent, missing facts, and risks; do not
push any specific sequence of actions.`;
  }
  const lines: string[] = [];
  lines.push(`ACTIVE PLAYBOOK: ${ctx.playbookName ?? ctx.playbookId}`);
  lines.push(`CURRENT STAGE: ${ctx.currentStageName ?? ctx.currentStageId}`);
  if (ctx.currentStageDescription) {
    lines.push(`STAGE DESCRIPTION: ${ctx.currentStageDescription}`);
  }
  if (ctx.currentStageExitCriteria) {
    lines.push(`EXIT CRITERIA: ${ctx.currentStageExitCriteria}`);
  }
  if (ctx.currentStagePrompts) {
    lines.push(`STAGE HINTS: ${ctx.currentStagePrompts}`);
  }
  return lines.join("\n");
}
