/**
 * The AI's actions, as Home reads them (Omer, 2026-11-03).
 *
 * Home's "updates" card, the in-flight line and the tools report read only
 * `tool_executions`, which only the legacy catalog executor (ai-assist,
 * crm-prefetch) writes. The AI employees' actions go through the action
 * orchestrator into `tool_execution_requests`. Dev held 0 rows in the first
 * and ~1,100 completed in the second; prod 0 and 12 (3 tenants, 30 days). So
 * the card was empty for everyone. The legacy table stays read (it still has
 * a writer); this adds the table the actions really land in.
 *
 * ROW SHAPE UNCHANGED. A request is projected onto the same
 * ToolExecutionLike the legacy rows use, so the feed's events keep their
 * shape and the frontend changes nothing.
 *
 * ONLY MAPPED TOOLS on the feed. A request row is written for every tool call,
 * including catalogue reads (woocommerce.list_products: 875 on dev). An
 * unmapped tool has no noun, and the feed would read as "list_products"
 * hundreds of times. The feed shows what TOOL_EVENTS names (refund, cancel,
 * order lookup, tracking, discount, lead...), by its bare name, so `kind` only
 * takes nouns the client already knows. Filtered in the WHERE, never after a
 * LIMIT, so paging stays honest.
 */
import type { ToolExecutionLike } from "@chatcenter/shared/src/lib/activity-events";
import { __ACTIVITY_INTERNALS__ } from "@chatcenter/shared/src/lib/activity-events";

/** `shopify.process_refund` -> `process_refund`; the prefix is routing, not a different act. */
export function bareTool(tool: string): string {
  return tool.includes(".") ? tool.slice(tool.lastIndexOf(".") + 1) : tool;
}

/** The tool slugs the activity contract has a noun for. */
export const FEED_TOOLS: readonly string[] = Object.keys(__ACTIVITY_INTERNALS__.TOOL_EVENTS);

/** WHERE: a mapped tool, bare or behind any integration prefix. */
export function feedToolWhere(): { OR: Array<{ tool: string } | { tool: { endsWith: string } }> } {
  return { OR: FEED_TOOLS.flatMap((t) => [{ tool: t }, { tool: { endsWith: `.${t}` } }]) };
}

/** What the feed selects from a request. */
export const requestSelect = {
  id: true, tool: true, args: true, result: true, completedAt: true, conversationId: true,
} as const;

export interface RequestRow {
  id: string;
  tool: string;
  args: unknown;
  result: unknown;
  completedAt: Date | null;
  conversationId: string | null;
}

/** A completed request as the row toActivityEvent already reads. `createdAt` is when it finished. */
export function requestToExecutionLike(r: RequestRow): ToolExecutionLike {
  return {
    id: r.id,
    toolName: bareTool(r.tool),
    input: r.args,
    output: r.result,
    success: true,
    createdAt: r.completedAt as Date,
    conversationId: r.conversationId ?? null,
  };
}
