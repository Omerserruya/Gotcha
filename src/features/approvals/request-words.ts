import type { Approval } from '@/api/contracts/approvals';

/**
 * 03's words for a pending request, from its own facts — a message key under
 * `approvals.request` and its values, so the wording stays in the catalogue.
 * Only what is known is said; with nothing, the platform's own summary.
 */
export type Words = { readonly key: string; readonly values: Record<string, string> };

type Facts = Pick<Approval, 'tool' | 'summary' | 'facts' | 'conversationId'>;

const kindOf = (tool: string) => {
  const slug = tool
    .split('.')
    .pop()!
    .replace(/^integration_/, '');
  return /refund/.test(slug) ? 'refund' : slug === 'cancel_order' ? 'cancel' : 'other';
};

/** The queue's short title — 02's "Refund ₪179", "Cancel order #4812". */
export function queueTitle(approval: Facts, amount: string | null): Words | null {
  const kind = kindOf(approval.tool);
  if (kind === 'refund' && amount) return { key: 'queueRefund', values: { amount } };
  if (kind === 'refund' && approval.facts.order)
    return { key: 'queueRefundOrder', values: { order: approval.facts.order } };
  if (kind === 'cancel' && approval.facts.order)
    return { key: 'queueCancel', values: { order: approval.facts.order } };
  return null;
}

/** The detail's title — 02's "Refund ₪179 to Dana Cohen". */
export function requestTitle(
  approval: Facts,
  name: string | null,
  amount: string | null,
): Words | null {
  const kind = kindOf(approval.tool);
  const order = approval.facts.order;
  if (kind === 'refund') {
    if (amount && name) return { key: 'refundTo', values: { amount, name } };
    if (amount && order) return { key: 'refundOn', values: { amount, order } };
    if (amount) return { key: 'queueRefund', values: { amount } };
    if (order && name) return { key: 'refundOrderFor', values: { order, name } };
    if (order) return { key: 'queueRefundOrder', values: { order } };
  }
  if (kind === 'cancel' && order) {
    return name
      ? { key: 'cancelFor', values: { order, name } }
      : { key: 'queueCancel', values: { order } };
  }
  return name ? { key: 'summaryFor', values: { summary: approval.summary, name } } : null;
}

/**
 * "What happens if you approve" — each step one the platform takes. The
 * customer is told only where there is a conversation to tell them in
 * (`sendApprovalContinuation`); nothing claims the conversation is resolved.
 */
export function approveChain(
  approval: Facts,
  name: string | null,
  amount: string | null,
): readonly Words[] {
  const kind = kindOf(approval.tool);
  const order = approval.facts.order;
  const shopify = approval.tool.startsWith('shopify.');
  const steps: Words[] = [];
  if (kind === 'refund') {
    steps.push(
      amount
        ? { key: 'stepRefunded', values: { amount } }
        : order
          ? { key: 'stepOrderRefunded', values: { order } }
          : { key: 'stepRuns', values: { summary: approval.summary } },
    );
    if (shopify) steps.push({ key: 'stepShopifyRefund', values: {} });
  } else if (kind === 'cancel' && order) {
    steps.push({ key: shopify ? 'stepCancelledShopify' : 'stepCancelled', values: { order } });
  } else {
    steps.push({ key: 'stepRuns', values: { summary: approval.summary } });
  }
  if (approval.conversationId) {
    steps.push(name ? { key: 'stepToldName', values: { name } } : { key: 'stepTold', values: {} });
  }
  return steps;
}

/** "Why GOTCHA recommends it" as 02's bullets — one per sentence or line. */
export function whyBullets(reason: string): readonly string[] {
  return reason
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z֐-׿0-9"'(])/)
    .map((part) => part.trim().replace(/^[-•·]\s*/, ''))
    .filter(Boolean);
}

/**
 * 02's "Reversible", by what the action is (Omer, 2026-10-04) — and nothing
 * where it is not known. Money moved, an order cancelled, a message sent:
 * no. A note, a tag, an address on an order not yet shipped: yes. There is
 * no Undo here; this says whether it CAN be put back, not that we will.
 */
export function reversibilityOf(tool: string): 'yes' | 'no' | null {
  const slug = tool
    .split('.')
    .pop()!
    .replace(/^integration_/, '');
  if (/refund/.test(slug)) return 'no';
  if (['cancel_order', 'send_invoice', 'resend_confirmation'].includes(slug)) return 'no';
  if (
    ['add_order_note', 'add_vip_tag', 'update_customer', 'update_order_shipping_address'].includes(
      slug,
    )
  )
    return 'yes';
  return null;
}

/**
 * The tools an approver may edit, the one field each takes and its unit —
 * backend 05979604 (amount) and f16a5afa (percentage): `major` up to two
 * decimals, `minor` whole numbers, `percent` up to two decimals and never
 * above 100. On any other tool there is no edit at all.
 */
export const EDITABLE: Readonly<
  Record<string, { readonly field: 'amount' | 'percentage'; readonly unit: EditUnit }>
> = {
  'shopify.process_refund': { field: 'amount', unit: 'major' },
  'paypal.refund_capture': { field: 'amount', unit: 'major' },
  'paypal.create_payment_link': { field: 'amount', unit: 'major' },
  'stripe.refund_payment': { field: 'amount', unit: 'minor' },
  'stripe.create_payment_link': { field: 'amount', unit: 'minor' },
  'square.refund_payment': { field: 'amount', unit: 'minor' },
  'square.create_payment_link': { field: 'amount', unit: 'minor' },
  'shopify.create_discount_code': { field: 'percentage', unit: 'percent' },
  'shopify.create_one_time_coupon': { field: 'percentage', unit: 'percent' },
  'shopify.create_vip_coupon': { field: 'percentage', unit: 'percent' },
  'shopify.issue_compensation_coupon': { field: 'percentage', unit: 'percent' },
};
export type EditUnit = 'major' | 'minor' | 'percent';

/** What may be edited on this request, and from what — `null` when nothing may. */
export function editTarget(approval: Pick<Approval, 'tool' | 'facts'>): {
  readonly field: 'amount' | 'percentage';
  readonly unit: EditUnit;
  /** `null`: the call carries none to edit (a full refund) — drawn, with why. */
  readonly original: number | null;
} | null {
  const rule = EDITABLE[approval.tool];
  if (!rule) return null;
  return {
    ...rule,
    original: rule.field === 'amount' ? approval.facts.amount : approval.facts.percentage,
  };
}

/** An edited value: positive, in the unit, no more than what was asked (nor 100%). */
export function editedValueProblem(
  raw: string,
  original: number,
  unit: EditUnit = 'major',
): 'invalid' | 'over' | null {
  const text = raw.trim().replace(',', '.');
  const value = Number(text);
  if (text === '' || !Number.isFinite(value) || value <= 0) return 'invalid';
  if (unit === 'minor' ? !Number.isInteger(value) : !/^\d+(\.\d{1,2})?$/.test(text)) {
    return 'invalid';
  }
  if (unit === 'percent' && value > 100) return 'invalid';
  if (value > original) return 'over';
  return null;
}
