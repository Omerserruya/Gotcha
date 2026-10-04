import type { Approval } from '@/api/contracts/approvals';

/**
 * 03c's row as 02 writes it — "Refunded ₪179 to Dana Cohen", "Cancelled order
 * #4812 for Rotem Shani" — from the approval's own facts and the customer of
 * its conversation. Only what is known is said: no name, no "to"; no amount,
 * the order; neither, the platform's own summary.
 *
 * Returns a message key under `decided.sentence` and its values, so the
 * wording stays in the catalogue.
 */
export function decisionSentence(
  approval: Pick<Approval, 'tool' | 'status' | 'summary' | 'facts'>,
  name: string | null,
  amount: string | null,
): { readonly key: string; readonly values: Record<string, string> } {
  const slug = approval.tool
    .split('.')
    .pop()!
    .replace(/^integration_/, '');
  const order = approval.facts.order;
  const done = approval.status === 'APPROVED';
  const fallback = (): { readonly key: string; readonly values: Record<string, string> } =>
    name
      ? { key: 'withName', values: { summary: approval.summary, name } }
      : { key: 'none', values: { summary: approval.summary } };

  if (/refund/.test(slug)) {
    const p = done ? 'refunded' : 'refundAsked';
    if (amount && name) return { key: p, values: { amount, name } };
    if (amount && order) return { key: `${p}On`, values: { amount, order } };
    if (order && name) return { key: `${p}OrderFor`, values: { order, name } };
    if (order) return { key: `${p}Order`, values: { order } };
    return fallback();
  }
  if (slug === 'cancel_order' && order) {
    const p = done ? 'cancelled' : 'cancelAsked';
    return name ? { key: p, values: { order, name } } : { key: `${p}Order`, values: { order } };
  }
  return fallback();
}
