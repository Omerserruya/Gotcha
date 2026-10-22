/**
 * A plan's words for the person reading it. A step that assigns a
 * conversation is stored for anyone ("לשייך ל-Matan את השיחה של ...") and,
 * for its assignee, as "you" ("לשייך אליך את השיחה של ..."): the summary
 * used to be written for the requester only, so an approver read "assign it
 * to you" about somebody else (2026-10-08).
 *
 * The twin of services/ai/src/lib/plan-summary.ts (the assistant's reads);
 * keep the two in step.
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

/** An approval row as this reader sees it: its summary, and each plan step's, in their words. */
export function approvalFor<T extends { tool: string; summary: string; params?: unknown }>(row: T, viewerId: string | null | undefined): T {
  if (row.tool !== "propose_plan") return row;
  const p = (row.params ?? {}) as Record<string, any>;
  const steps = Array.isArray(p.steps) ? p.steps.map((s: any) => ({ ...s, summary: stepSummaryFor(s ?? {}, viewerId) })) : p.steps;
  return { ...row, summary: approvalSummaryFor(row, viewerId), params: { ...p, ...(steps ? { steps, summary: planSummaryFor(p.steps, viewerId) ?? p.summary } : {}) } };
}
