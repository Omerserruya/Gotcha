import type { PlanTarget } from '@/api/contracts/approvals';

/**
 * Where a plan step's target opens: its conversation, its customer, the open
 * questions. Shared by Approvals and Home's proposal card, so a step opens in
 * the same place wherever it is decided.
 */
export function stepHref(target: PlanTarget) {
  if (target.conversationId)
    return { pathname: '/inbox' as const, query: { c: target.conversationId } };
  if (target.customerId) return `/customers/${target.customerId}`;
  if (target.questionId)
    return { pathname: '/studio/knowledge' as const, query: { section: 'gaps' } };
  return null;
}
