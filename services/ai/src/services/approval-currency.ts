/**
 * The order's real currency, written into an approval when it is created.
 *
 * `shopify.process_refund` takes its amount "in the order currency" and carries
 * no currency of its own, so an approver reading "refund 179" did not know 179
 * of what. The currency is read from the ORDER - never guessed, never taken
 * from the store's default, never defaulted to USD. When there is no order, or
 * the order cannot be read, or what comes back is not an ISO code, the field is
 * simply absent: an approval that says nothing is honest, one that says "USD"
 * on a shekel order is a different amount of money.
 *
 * Only for tools where the currency is part of what runs. process_refund
 * accepts `currency` and REFUSES a mismatch with the order at execution
 * (refund_currency_mismatch), so writing the order's own currency can never
 * change what is refunded. Tools that take no currency get nothing added -
 * params are dispatched as-is, and an argument a tool never declared is not
 * this module's to invent.
 *
 * A currency the model already supplied is never overwritten: if it is wrong,
 * replacing it would silently turn "200 USD" into "200 ILS"; leaving it lets
 * the adapter refuse the mismatch out loud.
 */
import { executeAdapterTool } from "./connectors/integration-framework";

export const CURRENCY_TOOLS: ReadonlySet<string> = new Set(["shopify.process_refund"]);

const ISO_4217 = /^[A-Z]{3}$/;
const LOOKUP_TIMEOUT_MS = 5000;

export function normalizeCurrency(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const c = raw.trim().toUpperCase();
  return ISO_4217.test(c) ? c : null;
}

function orderTarget(params: Record<string, unknown>): Record<string, string> | null {
  const id = params.order_id;
  const name = params.order_name;
  if (typeof id === "string" && id.trim()) return { order_id: id.trim() };
  if (typeof id === "number" && Number.isFinite(id)) return { order_id: String(id) };
  if (typeof name === "string" && name.trim()) return { order_name: name.trim() };
  return null;
}

/** Reads the order's currency through the adapter's own read tool. */
export type OrderCurrencyLookup = (tenantId: string, target: Record<string, string>, conversationId?: string) => Promise<unknown>;

export const adapterOrderCurrency: OrderCurrencyLookup = async (tenantId, target, conversationId) => {
  const call = executeAdapterTool({
    tenantId,
    conversationId,
    toolFunctionName: "shopify.get_financial_status",
    args: target,
    accessScope: "internal",
  });
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), LOOKUP_TIMEOUT_MS));
  const r: any = await Promise.race([call, timeout]);
  return r?.ok ? (r.result as any)?.currency : null;
};

/**
 * Params with the order's currency added, when the tool takes one, the params
 * name an order, none is set yet, and the order says. Otherwise the params
 * come back unchanged. Never throws: a failed lookup must not cost the
 * approval row.
 */
export async function withOrderCurrency(
  tenantId: string,
  tool: string,
  params: Record<string, unknown>,
  opts: { conversationId?: string; lookup?: OrderCurrencyLookup } = {},
): Promise<Record<string, unknown>> {
  if (!CURRENCY_TOOLS.has(tool)) return params;
  if (params.currency != null && params.currency !== "") return params;
  const target = orderTarget(params);
  if (!target) return params;
  try {
    const currency = normalizeCurrency(await (opts.lookup ?? adapterOrderCurrency)(tenantId, target, opts.conversationId));
    return currency ? { ...params, currency } : params;
  } catch {
    return params;
  }
}

/**
 * Same rule when the caller already HOLDS the resolved order (the commerce
 * panel resolves it before deciding on approval) - no second lookup.
 */
export function withKnownOrderCurrency(
  tool: string,
  params: Record<string, unknown>,
  orderCurrency: unknown,
): Record<string, unknown> {
  if (!CURRENCY_TOOLS.has(tool)) return params;
  if (params.currency != null && params.currency !== "") return params;
  const currency = normalizeCurrency(orderCurrency);
  return currency ? { ...params, currency } : params;
}
