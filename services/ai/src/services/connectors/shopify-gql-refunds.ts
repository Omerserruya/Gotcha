/**
 * Refunds, on Admin GraphQL.
 *
 * Family 7, migrated last on purpose: this is the only family that moves money,
 * and a mistake here is not a wrong answer to a customer, it is a wrong amount
 * leaving a merchant's account.
 *
 * The two-step flow REST used - price it, then create it - survives exactly,
 * because it is the flow that makes the refund SAFE: Shopify is asked what is
 * actually refundable per gateway transaction, the answer is checked against
 * what was requested, and only then is anything created.
 *
 *   * `Order.suggestedRefund` replaces `POST /refunds/calculate.json`. It is a
 *     QUERY - it prices a refund and creates nothing - which is a better
 *     guarantee than REST's calculate endpoint gave, where "calculate" and
 *     "create" differed only by a path segment.
 *   * `refundCreate` replaces `POST /refunds.json`.
 *
 * ── Idempotency is now Shopify's, not ours ──
 *
 * From 2026-04 `refundCreate` REQUIRES an idempotency key via the
 * `@idempotent` directive. That is a real improvement over REST, where a
 * redelivered job or a retried approval could create a second refund and the
 * only defence was our own bookkeeping. The key here is DERIVED from the refund
 * itself - the order, the amount, the lines, the reason - so the same logical
 * refund attempted twice is deduplicated by Shopify, while a genuinely
 * different refund on the same order still goes through.
 *
 * The mutation is never retried by the transport either. Between the two, a
 * double refund needs both a repeat AND a different key.
 */
import { createHash } from "node:crypto";
import { shopifyGraphQLRequest, toGid, numericId, type ShopifyCtx } from "./shopify-graphql";

const SUGGESTED_REFUND = `
  query GotchaSuggestedRefund($id: ID!, $refundLineItems: [RefundLineItemInput!], $refundShipping: Boolean) {
    order(id: $id) {
      suggestedRefund(refundLineItems: $refundLineItems, refundShipping: $refundShipping) {
        amountSet { shopMoney { amount currencyCode } }
        maximumRefundableSet { shopMoney { amount } }
        shipping { amountSet { shopMoney { amount } } }
        suggestedTransactions {
          amountSet { shopMoney { amount currencyCode } }
          gateway
          kind
          parentTransaction { id }
        }
      }
    }
  }`;

const ORDER_REFUNDS = `
  query GotchaOrderRefunds($id: ID!) {
    order(id: $id) {
      refunds(first: 30) {
        legacyResourceId
        createdAt
        note
        totalRefundedSet { shopMoney { amount currencyCode } }
        refundLineItems(first: 50) { nodes { lineItem { id } quantity restockType } }
        transactions(first: 20) { nodes { id status kind amountSet { shopMoney { amount } } gateway } }
      }
    }
  }`;

const REFUND_CREATE = `
  mutation GotchaRefundCreate($input: RefundInput!, $idempotencyKey: String!) {
    refundCreate(input: $input) @idempotent(key: $idempotencyKey) {
      refund {
        legacyResourceId
        createdAt
        totalRefundedSet { shopMoney { amount currencyCode } }
        transactions(first: 20) { nodes { id status kind amountSet { shopMoney { amount } } gateway } }
      }
      userErrors { field message }
    }
  }`;

function money(set: any): string | null {
  const amount = set?.shopMoney?.amount;
  return amount == null ? null : String(amount);
}

/** A refund line as both the pricing query and the mutation take it. */
export interface RefundLine {
  line_item_id: number;
  quantity: number;
  restock_type: string;
  location_id?: number;
}

/**
 * REST's restock vocabulary, uppercased for the GraphQL enum.
 *
 * The values are the same four words - no_restock / cancel / return /
 * legacy_restock - and the distinction they carry is not cosmetic: it decides
 * whether Shopify treats a unit as never-shipped or as physically returned.
 */
function restockType(v: unknown): string {
  const s = String(v ?? "no_restock").toUpperCase();
  return ["NO_RESTOCK", "CANCEL", "RETURN", "LEGACY_RESTOCK"].includes(s) ? s : "NO_RESTOCK";
}

function toRefundLineInput(li: RefundLine): Record<string, unknown> {
  return {
    lineItemId: toGid("LineItem", li.line_item_id),
    quantity: li.quantity,
    restockType: restockType(li.restock_type),
    ...(li.location_id != null ? { locationId: toGid("Location", li.location_id) } : {}),
  };
}

export interface SuggestedRefund {
  currency: string | null;
  /** What Shopify suggests refunding, per gateway transaction. */
  transactions: Array<{ parent_id: string | null; amount: string; gateway: string | null }>;
  shipping: { amount: string | null };
  maximum_refundable: string | null;
}

/**
 * Ask Shopify what is refundable, without refunding anything.
 *
 * A QUERY, so there is no version of this call that moves money by accident.
 */
export async function suggestRefund(
  ctx: ShopifyCtx,
  orderId: string | number,
  lines: RefundLine[],
  refundShipping: boolean,
): Promise<SuggestedRefund | null> {
  const data = await shopifyGraphQLRequest(
    ctx,
    SUGGESTED_REFUND,
    {
      id: toGid("Order", orderId),
      refundLineItems: lines.map(toRefundLineInput),
      refundShipping,
    },
    { retryable: true },
  );
  const s = data?.order?.suggestedRefund;
  if (!s) return null;
  return {
    currency: s.amountSet?.shopMoney?.currencyCode ?? null,
    transactions: (s.suggestedTransactions || []).map((tx: any) => ({
      // The gid, kept as-is: it goes straight back to `refundCreate` as
      // `parentId` and no caller reads it as a number.
      parent_id: tx?.parentTransaction?.id ?? null,
      amount: money(tx?.amountSet) ?? "0.00",
      gateway: tx?.gateway ?? null,
    })),
    shipping: { amount: money(s.shipping?.amountSet) },
    maximum_refundable: money(s.maximumRefundableSet),
  };
}

/** Refunds already on an order, in the REST shape the reconciler reads. */
export async function listOrderRefunds(ctx: ShopifyCtx, orderId: string | number): Promise<any[]> {
  const data = await shopifyGraphQLRequest(ctx, ORDER_REFUNDS, { id: toGid("Order", orderId) }, { retryable: true });
  return (data?.order?.refunds || []).map((r: any) => ({
    id: r?.legacyResourceId == null ? null : Number(r.legacyResourceId),
    created_at: r?.createdAt ?? null,
    note: r?.note ?? null,
    total: money(r?.totalRefundedSet),
    refund_line_items: (r?.refundLineItems?.nodes || []).map((rli: any) => ({
      line_item_id: numericId(rli?.lineItem),
      quantity: rli?.quantity ?? null,
      // Lowercased back to REST's words: callers test for `!== "no_restock"`
      // to tell a customer whether the goods went back into stock.
      restock_type: rli?.restockType ? String(rli.restockType).toLowerCase() : null,
    })),
    transactions: (r?.transactions?.nodes || []).map(mapTransaction),
  }));
}

/**
 * A transaction in REST's words.
 *
 * `status` in particular: callers test for the literal `"success"` to decide
 * whether to tell a customer the money has moved or is still on its way, and
 * GraphQL's enum is `SUCCESS`.
 */
function mapTransaction(tx: any): { id: number | null; status: string | null; kind: string | null; amount: string | null; gateway: string | null } {
  return {
    id: numericId(tx),
    status: tx?.status ? String(tx.status).toLowerCase() : null,
    kind: tx?.kind ? String(tx.kind).toLowerCase() : null,
    amount: money(tx?.amountSet),
    gateway: tx?.gateway ?? null,
  };
}

export interface RefundCreateInput {
  currency: string;
  note: string;
  notify: boolean;
  transactions: Array<{ parent_id: string | null; amount: string; gateway?: string | null }>;
  refund_line_items?: RefundLine[];
  shipping?: { amount: string };
}

/**
 * The idempotency key for one refund.
 *
 * Derived, not random: a redelivered job or a retried approval must produce the
 * SAME key so Shopify returns the refund that already exists instead of
 * creating a second one. It covers everything that makes this refund what it is
 * - the order, the money, the lines, the note - so a genuinely different refund
 * on the same order gets a different key and is not suppressed.
 */
export function refundIdempotencyKey(orderId: string | number, input: RefundCreateInput): string {
  const canonical = JSON.stringify({
    order: String(orderId),
    currency: input.currency,
    note: input.note,
    transactions: input.transactions.map((t) => ({ parent: t.parent_id, amount: t.amount })),
    lines: (input.refund_line_items || []).map((l) => ({ id: l.line_item_id, q: l.quantity, r: l.restock_type })),
    shipping: input.shipping?.amount ?? null,
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 40);
}

/**
 * Create the refund.
 *
 * Never retried by the transport, and keyed so that even a repeat outside this
 * process cannot produce a second refund within Shopify's idempotency window.
 * A `userErrors` response throws rather than returning - a refund that did not
 * happen must never be reported as one that did.
 */
export async function createRefund(
  ctx: ShopifyCtx,
  orderId: string | number,
  input: RefundCreateInput,
): Promise<{ id: number | null; processed_at: string | null; total: string | null; transactions: any[] } | null> {
  const payload: Record<string, unknown> = {
    orderId: toGid("Order", orderId),
    currency: input.currency,
    note: input.note,
    notify: input.notify,
    transactions: input.transactions.map((t) => ({
      orderId: toGid("Order", orderId),
      parentId: t.parent_id,
      amount: t.amount,
      kind: "REFUND",
      ...(t.gateway ? { gateway: t.gateway } : {}),
    })),
    ...(input.refund_line_items?.length ? { refundLineItems: input.refund_line_items.map(toRefundLineInput) } : {}),
    ...(input.shipping ? { shipping: { amount: input.shipping.amount } } : {}),
  };

  const data = await shopifyGraphQLRequest(
    ctx,
    REFUND_CREATE,
    { input: payload, idempotencyKey: refundIdempotencyKey(orderId, input) },
    { userErrorsAt: "refundCreate" },
  );
  const r = data?.refundCreate?.refund;
  if (!r) return null;
  return {
    id: r.legacyResourceId == null ? null : Number(r.legacyResourceId),
    // REST reported `processed_at`; `createdAt` is when the refund record came
    // into being, which is the same moment for a synchronous gateway and the
    // best available answer for an asynchronous one.
    processed_at: r.createdAt ?? null,
    total: money(r.totalRefundedSet),
    transactions: (r.transactions?.nodes || []).map(mapTransaction),
  };
}
