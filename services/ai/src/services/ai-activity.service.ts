/**
 * What the AI is doing in a conversation, step by step - for the inbox panel's
 * live line ("Looking up the order…", "Checking stock…").
 *
 * The source is tool_execution_requests: every chat tool call already goes
 * through the ActionOrchestrator, which writes a row per call and moves its
 * status (proposed → running → completed | failed, or denied/approved). This
 * module only READS it, and projects each step without its arguments or its
 * result - the same rule the orchestrator's events follow.
 *
 * `labelKey` is a stable key for the screen to translate, not prose: the
 * panel is bilingual and the tool name ("shopify.reconcile_order_items") is
 * not something to show a merchant.
 */
import { prisma } from "@chatcenter/shared";
import { activityLabelKey, ACTIVITY_LABEL_KEYS as SHARED_LABEL_KEYS } from "@chatcenter/shared/src/lib/ai-activity-labels";

export type ActivityStatus = "proposed" | "approved" | "running" | "completed" | "failed" | "denied";

// The label map is shared with the customer timeline (conversation service),
// so a tool reads the same in the live line and in the history. Deep-imported
// from its import-free file; see packages/shared/src/lib/ai-activity-labels.ts.

export const ACTIVITY_LABEL_KEYS = SHARED_LABEL_KEYS;

export function labelKeyFor(tool: string): string {
  return activityLabelKey(tool);
}

/** The orchestrator's lifecycle event name → the step's status. */
export function statusForEvent(event: string): ActivityStatus | null {
  const m = /^tool\.execution\.(proposed|approved|started|completed|failed|denied)$/.exec(event);
  if (!m) return null;
  return m[1] === "started" ? "running" : (m[1] as ActivityStatus);
}

export interface ActivityStep {
  id: string;
  tool: string;
  labelKey: string;
  status: string;
  proposedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  /** Only for failed/denied steps; the provider's message, never the args. */
  error: string | null;
}

const MAX_LIMIT = 50;

/** The last `limit` steps for one conversation, newest first. */
export async function getAiActivity(tenantId: string, conversationId: string, limit = 20): Promise<ActivityStep[]> {
  const take = Math.min(Math.max(1, Math.floor(limit) || 20), MAX_LIMIT);
  const rows = await (prisma as any).toolExecutionRequest.findMany({
    where: { tenantId, conversationId },
    orderBy: { proposedAt: "desc" },
    take,
    // args/result are deliberately NOT selected: they hold customer data and
    // the panel needs neither.
    select: { id: true, tool: true, status: true, error: true, proposedAt: true, startedAt: true, completedAt: true },
  });
  return rows.map((r: any) => ({
    id: r.id,
    tool: r.tool,
    labelKey: labelKeyFor(r.tool),
    status: r.status,
    proposedAt: r.proposedAt?.toISOString?.() ?? String(r.proposedAt),
    startedAt: r.startedAt ? r.startedAt.toISOString() : null,
    completedAt: r.completedAt ? r.completedAt.toISOString() : null,
    durationMs: r.startedAt && r.completedAt ? r.completedAt.getTime() - r.startedAt.getTime() : null,
    error: r.status === "failed" || r.status === "denied" ? (r.error ?? null) : null,
  }));
}
