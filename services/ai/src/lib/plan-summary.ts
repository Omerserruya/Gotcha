/**
 * A plan's words for the person reading it. A step that assigns a
 * conversation is stored for anyone ("לשייך ל-Matan את השיחה של ...") and,
 * for its assignee, as "you" ("לשייך אליך את השיחה של ..."): the summary
 * used to be written for the requester only, so an approver read "assign it
 * to you" about somebody else (2026-10-08).
 *
 * The twin of services/conversation/src/lib/plan-summary.ts (the approvals
 * API); keep the two in step.
 */
interface SummaryStep { summary?: unknown; summaryForAssignee?: unknown; target?: { assigneeId?: unknown } | null }

/** One step, for this reader. */
export function stepSummaryFor(step: SummaryStep, viewerId: string | null | undefined): string {
  const forAssignee = typeof step.summaryForAssignee === "string" ? step.summaryForAssignee : null;
  if (forAssignee && viewerId && step.target?.assigneeId === viewerId) return forAssignee;
  return typeof step.summary === "string" ? step.summary : "";
}

/** A plan's steps, for this reader, joined as the stored summary is. Null when it has none. */
export function planSummaryFor(steps: unknown, viewerId: string | null | undefined): string | null {
  if (!Array.isArray(steps) || !steps.length) return null;
  const said = (steps as SummaryStep[]).map((s) => stepSummaryFor(s ?? {}, viewerId)).filter(Boolean);
  return said.length ? said.join("; ") : null;
}

/** An approval's summary for this reader: a plan's from its steps, anything else as stored. */
export function approvalSummaryFor(a: { tool: string; summary: string; params?: unknown }, viewerId: string | null | undefined): string {
  if (a.tool !== "propose_plan") return a.summary;
  return planSummaryFor((a.params as any)?.steps, viewerId) ?? a.summary;
}
