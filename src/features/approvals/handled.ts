import type { Approval } from '@/api/contracts/approvals';
import type { ToolUsage } from '@/api/contracts/capabilities';

/**
 * 03c's dark card — "handled without asking you · today".
 *
 * ★ HOW IT IS COUNTED, BECAUSE NOTHING COUNTS IT FOR US. `tool-usage` gives
 * each tool's successful runs from an instant (ToolExecution plus the
 * `adapter.*` audit). It does not say which ran after an approval, so those
 * are taken off by tool: an approval APPROVED today whose execution
 * SUCCEEDED is one run that asked you. What is left ran on its own.
 *
 * No value: no run records an amount, and "₪N of value" is not invented.
 */
export interface HandledToday {
  readonly total: number;
  readonly refunds: number;
  readonly lookups: number;
  readonly returns: number;
}

/** `shopify.process_refund` and `process_refund` are one tool. */
const slugOf = (tool: string) => tool.split('.').pop() ?? tool;

const KIND = {
  refunds: /refund/,
  lookups: /^(get_order|get_orders|order_lookup|find_latest_order|get_order_items)$/,
  returns: /^create_return$/,
} as const;

export function startOfToday(now: Date): Date {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day;
}

export function handledToday(
  usage: readonly ToolUsage[] | null,
  decided: readonly Approval[] | null,
  now: Date,
): HandledToday | null {
  // Without the decisions, approved runs cannot be told from autonomous ones.
  if (usage === null || decided === null) return null;
  const since = startOfToday(now).getTime();
  const asked = new Map<string, number>();
  for (const approval of decided) {
    if (
      approval.status === 'APPROVED' &&
      approval.executionState === 'SUCCEEDED' &&
      approval.decidedAt !== null &&
      Date.parse(approval.decidedAt) >= since
    ) {
      const slug = slugOf(approval.tool);
      asked.set(slug, (asked.get(slug) ?? 0) + 1);
    }
  }

  const alone = new Map<string, number>();
  for (const row of usage) {
    const slug = slugOf(row.toolName);
    alone.set(slug, (alone.get(slug) ?? 0) + row.successCount);
  }
  let total = 0;
  const by = { refunds: 0, lookups: 0, returns: 0 };
  for (const [slug, ran] of alone) {
    const own = Math.max(0, ran - (asked.get(slug) ?? 0));
    total += own;
    for (const kind of Object.keys(KIND) as (keyof typeof KIND)[]) {
      if (KIND[kind].test(slug)) by[kind] += own;
    }
  }
  return { total, ...by };
}
