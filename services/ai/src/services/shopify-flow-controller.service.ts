/**
 * The critical Shopify flows, owned by code rather than by the model.
 *
 * Parts 1-5 built containment: prechecks that refuse impossible actions, an
 * outcome contract that refuses unsupported claims, a guard that refuses
 * cross-customer reads. All of it works, and the honest summary at the end of
 * Part 5 was that the mechanisms had become stronger than the behaviour they
 * were containing. The model still:
 *
 *   - raised an exchange approval with `{quantity: 1, order_name: "1012"}` and
 *     no replacement variant at all, which a human then approved
 *   - answered a colour-swap question by calling `variant_information` with a
 *     product name guessed from the customer's word for the item, landing on a
 *     different single-variant snowboard, and told the customer their product
 *     came in one version only
 *   - reached for `link_customer_identifier` when asked to change an email
 *   - produced two turns with no text at all
 *
 * Every one was caught. Catching is not the same as not happening, and a human
 * approving an exchange with nothing to exchange to is a decision spent on
 * nothing.
 *
 * So for the flows where a mistake is irreversible or expensive, the facts are
 * resolved HERE, deterministically, before the model is asked to say anything:
 * which order, which line, which variant, what it costs, whether it is still
 * eligible. The model receives facts and a single permitted action with its
 * arguments already filled in. It writes the sentence; it does not choose the
 * move.
 *
 * What is deliberately NOT here: tone, language, empathy, and every
 * conversational flow that is not irreversible. Those are what the model is
 * genuinely better at, and a state machine over them would be worse.
 */

import { detectMissingItemIntent, detectProfileUpdateIntent, detectOrderAddressIntent, detectExchangeIntent, detectReturnIntent } from "./customer-request-intents.service";
import { quoteExchange, type ExchangeQuote } from "./connectors/shopify-exchange";
import { assessMutability } from "./connectors/shopify-order-mutability";

export type FlowIntent =
  | "cancel_order"
  | "refund"
  | "profile_update"
  | "address_update"
  | "exchange"
  | "return"
  | "missing_item"
  | "note_tag"
  | "document_send";

/** A read against the provider. Injected so the controller is testable. */
export type ProviderCall = (tool: string, args: Record<string, any>) => Promise<any>;

export interface FlowContext {
  message: string;
  /** The conversation's own order anchor, if one is already established. */
  anchoredOrderName?: string | null;
  call: ProviderCall;
  /** Tool function names the AI actually holds this turn. */
  availableTools: string[];
}

export interface FlowFacts {
  intent: FlowIntent;
  orderName?: string | null;
  orderId?: string | null;
  /** Fulfillment eligibility, from fulfillment orders - never the legacy field. */
  eligibility?: "editable" | "blocked" | "unknown";
  eligibilityReason?: string;
  lineItem?: { id: string; title: string; variant_title: string | null; variant_id: string; quantity: number; price: string; product_id: string } | null;
  /** Every real option for the product on that line. Never a search result. */
  options?: Array<{ variant_id: string; title: string; price: string; in_stock: boolean; available: number | null }>;
  quote?: ExchangeQuote | null;
  currency?: string | null;
  [k: string]: unknown;
}

export type FlowDecision =
  | { kind: "not_applicable" }
  /** Facts are incomplete. Ask the customer exactly this, call nothing. */
  | { kind: "need_input"; intent: FlowIntent; facts: FlowFacts; ask: string; directive: string }
  /** The flow cannot proceed at all. Say this; call nothing. */
  | { kind: "blocked"; intent: FlowIntent; facts: FlowFacts; directive: string }
  /** Everything is known. Call exactly this tool with exactly these arguments. */
  | { kind: "ready"; intent: FlowIntent; facts: FlowFacts; tool: string; args: Record<string, any>; directive: string };

// ─── Order resolution ───────────────────────────────────────

/**
 * The order number the customer actually named, or the one already anchored.
 *
 * Deliberately conservative. It reads a number the customer typed and nothing
 * else - it does not "find the most likely order", because an order chosen by
 * inference and then cancelled is the worst outcome this whole file exists to
 * prevent.
 */
export function orderNameFromMessage(message: string): string | null {
  const m = /(?:^|[^\d])#?(\d{4,6})(?![\d])/.exec(String(message ?? ""));
  return m ? `#${m[1]}` : null;
}

async function resolveOrder(ctx: FlowContext, facts: FlowFacts): Promise<any | null> {
  const named = orderNameFromMessage(ctx.message) ?? ctx.anchoredOrderName ?? null;
  if (!named) return null;
  try {
    const o = await ctx.call("shopify.get_order", { order_name: named });
    if (!o?.id) return null;
    facts.orderName = o.name ?? named;
    facts.orderId = String(o.id);
    facts.currency = o.currency ?? null;
    return o;
  } catch {
    return null;
  }
}

async function resolveEligibility(ctx: FlowContext, order: any, facts: FlowFacts): Promise<void> {
  try {
    const fs = await ctx.call("shopify.get_fulfillment_status", { order_id: facts.orderId });
    const m = assessMutability(order, {
      orders: fs?.fulfillment_orders ?? [],
      readable: fs?.fulfillment_orders_readable !== false,
    });
    facts.eligibility = m.verdict;
    facts.eligibilityReason = m.customer_explanation;
  } catch {
    facts.eligibility = "unknown";
    facts.eligibilityReason = "I cannot currently confirm whether this order has already gone out.";
  }
}

// ─── Exchange: the flow that most needs this ────────────────

/**
 * Resolve the line being exchanged and every REAL option for its product.
 *
 * The options come from the product on the ORDER LINE, never from a search.
 * A colour or a size only means anything within the exact product the customer
 * bought, and "Dawn" is a plausible name for something else in the catalogue.
 */
async function resolveExchangeContext(ctx: FlowContext, order: any, facts: FlowFacts): Promise<void> {
  const lines: any[] = order?.line_items ?? [];
  const line = lines.length === 1 ? lines[0] : null;
  if (!line) {
    facts.lineItem = null;
    return;
  }
  facts.lineItem = {
    id: String(line.id), title: String(line.title ?? ""), variant_title: line.variant_title ?? null,
    variant_id: String(line.variant_id ?? ""), quantity: Number(line.quantity ?? 0),
    price: String(line.price ?? ""), product_id: String(line.product_id ?? ""),
  };
  if (!line.product_id) return;
  try {
    const info = await ctx.call("shopify.variant_information", { product_id: String(line.product_id) });
    facts.options = (info?.variants ?? []).map((v: any) => ({
      variant_id: String(v.variant_id ?? v.id),
      title: String(v.title ?? ""),
      price: String(v.price ?? ""),
      in_stock: v.in_stock !== false,
      available: v.inventory_quantity ?? null,
    }));
  } catch {
    facts.options = [];
  }
}

/** The option the customer named, matched within the product they bought. */
export function matchRequestedOption(
  message: string,
  options: FlowFacts["options"],
  currentVariantId: string,
): { variant_id: string; title: string; price: string; in_stock: boolean; available: number | null } | null {
  if (!options?.length) return null;
  const text = String(message ?? "").toLowerCase();
  const candidates = options.filter((o) => String(o.variant_id) !== String(currentVariantId));
  // Longest title first, so "159" does not win over "1590" and "Ice Blue" is
  // preferred over "Ice" when both appear in the catalogue.
  const sorted = [...candidates].sort((a, b) => b.title.length - a.title.length);
  for (const o of sorted) {
    const t = o.title.trim().toLowerCase();
    if (!t || t === "default title") continue;
    if (text.includes(t)) return o;
  }
  return null;
}

async function exchangeFlow(ctx: FlowContext): Promise<FlowDecision> {
  const facts: FlowFacts = { intent: "exchange" };
  if (!ctx.availableTools.some((t) => t.endsWith(".exchange_order_item"))) {
    return { kind: "blocked", intent: "exchange", facts, directive:
      `The customer wants to exchange an item and you have no tool for it on this conversation. Say plainly that you cannot make the swap from here and offer a person. Do NOT say anything was exchanged, and do NOT offer a coupon or discount instead.` };
  }

  const order = await resolveOrder(ctx, facts);
  if (!order) {
    return { kind: "need_input", intent: "exchange", facts, ask: "which order",
      directive: `The customer wants an exchange but has not said which order. Ask for the order number. Call NOTHING until you have it - in particular do not call exchange_order_item, and do not guess from the conversation.` };
  }

  await resolveEligibility(ctx, order, facts);
  if (facts.eligibility !== "editable") {
    return { kind: "blocked", intent: "exchange", facts, directive:
      `${facts.eligibilityReason} An exchange is only an order edit before dispatch; after that it is a RETURN plus a replacement. Say exactly that, offer the return route, and do NOT say the item was exchanged or that a warehouse or courier was contacted.` };
  }

  await resolveExchangeContext(ctx, order, facts);
  if (!facts.lineItem) {
    return { kind: "need_input", intent: "exchange", facts, ask: "which item",
      directive: `Order ${facts.orderName} has more than one item, so you do not know which one they mean. Name the items on the order and ask which. Call NOTHING until they answer.` };
  }
  const opts = facts.options ?? [];
  const realOptions = opts.filter((o) => o.title.trim().toLowerCase() !== "default title");
  if (realOptions.length < 2) {
    return { kind: "blocked", intent: "exchange", facts, directive:
      `"${facts.lineItem.title}" is sold in one version only - it has no sizes, colours or other options, so there is nothing to exchange it for. Say exactly that. Do NOT run a product search and do NOT offer a different product as if it were an exchange.` };
  }

  const wanted = matchRequestedOption(ctx.message, opts, facts.lineItem.variant_id);
  if (!wanted) {
    const list = realOptions.map((o) => `${o.title}${o.in_stock ? "" : " (out of stock)"}`).join(", ");
    return { kind: "need_input", intent: "exchange", facts, ask: "which option",
      directive: `"${facts.lineItem.title}" comes in: ${list}. The customer currently has ${facts.lineItem.variant_title ?? "one of these"}. Ask which of THOSE options they want - list them exactly as written, invent none - and call NOTHING until they name one.` };
  }

  const quoted = quoteExchange({
    orderName: String(facts.orderName ?? ""),
    currency: String(facts.currency ?? ""),
    lineItem: order.line_items.find((l: any) => String(l.id) === facts.lineItem!.id) ?? null,
    variant: { id: wanted.variant_id, title: wanted.title, price: wanted.price,
      inventory_management: wanted.available == null ? null : "shopify", inventory_quantity: wanted.available ?? 0 },
    productTitle: facts.lineItem.title,
    quantity: quantityFromMessage(ctx.message) ?? facts.lineItem.quantity,
  });
  facts.quote = quoted.ok ? quoted.quote : (quoted.quote ?? null);

  if (!quoted.ok) {
    return { kind: "blocked", intent: "exchange", facts, directive:
      `${quoted.detail} Do NOT say the item was exchanged.` +
      (quoted.reason === "price_difference_requires_payment"
        ? ` The difference has to be paid and you cannot take payment here - say so and offer a real handover. Do NOT offer a discount, a coupon or a free upgrade to close the gap.`
        : quoted.reason === "price_difference_requires_refund"
          ? ` The replacement is cheaper and the difference must be settled separately - say so and offer a real handover. Do NOT promise a refund yourself and do NOT invent store credit.`
          : ` Offer only the options listed above.`) };
  }

  const q = quoted.quote;
  return {
    kind: "ready", intent: "exchange", facts,
    tool: "shopify.exchange_order_item",
    args: {
      order_name: facts.orderName,
      line_item_id: facts.lineItem.id,
      new_variant_id: q.requested_variant_id,
      quantity: q.quantity,
    },
    directive:
      `Everything needed for this exchange is already resolved and verified:\n` +
      `- order ${q.order_name}\n- currently: ${q.current_title} ${q.current_variant ?? ""} at ${q.current_unit_price} ${q.currency}\n` +
      `- replacing with: ${q.requested_variant ?? q.requested_title} at ${q.requested_unit_price} ${q.currency}\n` +
      `- quantity ${q.quantity}, price difference ${q.price_difference} ${q.currency}\n` +
      `Call shopify.exchange_order_item with EXACTLY these arguments and no others: ` +
      JSON.stringify({ order_name: facts.orderName, line_item_id: facts.lineItem.id, new_variant_id: q.requested_variant_id, quantity: q.quantity }) + `\n` +
      `Do not re-look-up the product, do not substitute a different variant, and do not change the quantity. ` +
      `Approval is raised by calling the tool. Say the item was exchanged ONLY after it returns exchange_completed: true.`,
  };
}

export function quantityFromMessage(message: string): number | null {
  const m = /(?:^|\s)(?:כמות\s*)?(\d{1,2})\s*(?:יחיד|יח['׳]|units?|pcs?)/i.exec(String(message ?? ""));
  if (m) return Number(m[1]);
  if (/(אחד|אחת|one|a single)/i.test(String(message ?? ""))) return 1;
  return null;
}

// ─── Return ─────────────────────────────────────────────────

async function returnFlow(ctx: FlowContext): Promise<FlowDecision> {
  const facts: FlowFacts = { intent: "return" };
  if (!ctx.availableTools.some((t) => t.endsWith(".create_return"))) {
    return { kind: "blocked", intent: "return", facts, directive:
      `No system connected to this conversation can open a return. You must NOT say a return, RMA or case was opened, and you must NOT say a request was "passed on". Gather order, item, quantity, reason and a photo if it is a damage claim, then create a REAL handoff and tell them a person is taking over only after it succeeds.` };
  }
  const order = await resolveOrder(ctx, facts);
  if (!order) {
    return { kind: "need_input", intent: "return", facts, ask: "which order",
      directive: `The customer wants to return something but has not said which order. Ask for the order number and call NOTHING until you have it.` };
  }

  const shipped = (order.fulfillments ?? []).filter((f: any) => String(f?.status ?? "").toLowerCase() !== "cancelled");
  facts.fulfilled = shipped.length > 0;
  if (!shipped.length) {
    return { kind: "blocked", intent: "return", facts, directive:
      `Nothing on order ${facts.orderName} has shipped yet, so there is nothing to return - a return covers items the customer has actually received. Say that plainly. If they want to stop the order instead, a cancellation or a refund is the right request. Do NOT say a return was opened.` };
  }

  try {
    const existing = await ctx.call("shopify.get_returns", { order_id: facts.orderId });
    const open = (existing?.returns ?? []).filter((r: any) => !["CLOSED", "CANCELED", "CANCELLED", "DECLINED"].includes(String(r.status ?? "").toUpperCase()));
    if (open.length) {
      facts.existingReturnId = String(open[0].id);
      return { kind: "blocked", intent: "return", facts, directive:
        `A return is ALREADY open on order ${facts.orderName} (status ${open[0].status}). Tell the customer it is already open and give them its status. Do NOT open another one.` };
    }
  } catch { /* a status read failure must not block a legitimate return */ }

  return {
    kind: "ready", intent: "return", facts,
    tool: "shopify.create_return",
    args: { order_name: facts.orderName, reason: returnReasonFromMessage(ctx.message) },
    directive:
      `Order ${facts.orderName} has delivered items and no open return, so a return can be opened.\n` +
      `Call shopify.create_return with EXACTLY: ${JSON.stringify({ order_name: facts.orderName, reason: returnReasonFromMessage(ctx.message) })} ` +
      `(add a short `+"`note`"+` in the customer's own words if they gave a reason).\n` +
      `Approval is raised by calling the tool. Say a return was opened ONLY after it returns return_created: true WITH a return id, and give them that id.`,
  };
}

/** Shopify's ReturnReason enum, from what the customer actually said. */
export function returnReasonFromMessage(message: string): string {
  const t = String(message ?? "");
  if (/(פגום|שבור|נזק|damaged|broken|defect)/i.test(t)) return "DEFECTIVE";
  if (/(מוצר\s*לא\s*נכון|לא\s*מה\s*שהזמנתי|wrong\s*item)/i.test(t)) return "WRONG_ITEM";
  if (/(גדול\s*מדי|too\s*(big|large))/i.test(t)) return "SIZE_TOO_LARGE";
  if (/(קטן\s*מדי|too\s*small)/i.test(t)) return "SIZE_TOO_SMALL";
  if (/(לא\s*כמו\s*בתיאור|not\s*as\s*described)/i.test(t)) return "NOT_AS_DESCRIBED";
  if (/(לא\s*רוצה|התחרטתי|unwanted|changed\s*my\s*mind)/i.test(t)) return "UNWANTED";
  return "UNKNOWN";
}

// ─── Address ────────────────────────────────────────────────

async function addressFlow(ctx: FlowContext): Promise<FlowDecision> {
  const facts: FlowFacts = { intent: "address_update" };
  if (!ctx.availableTools.some((t) => t.endsWith(".update_order_shipping_address"))) {
    return { kind: "blocked", intent: "address_update", facts, directive:
      `You cannot change an order's delivery address from this conversation. Say so and offer a person. Do NOT say the address was changed and do NOT say a courier was contacted.` };
  }
  const order = await resolveOrder(ctx, facts);
  if (!order) {
    return { kind: "need_input", intent: "address_update", facts, ask: "which order",
      directive: `Ask which order the address change is for. Call NOTHING until you have the order number.` };
  }
  await resolveEligibility(ctx, order, facts);
  if (facts.eligibility !== "editable") {
    return { kind: "blocked", intent: "address_update", facts, directive:
      `${facts.eligibilityReason} Say exactly that. Do NOT say the address was changed, and do NOT say the carrier, courier or warehouse has been contacted - nothing here reaches them. You may offer the tracking link if one exists, and a real handover if they want one.` };
  }
  return { kind: "need_input", intent: "address_update", facts, ask: "the full new address",
    directive:
      `Order ${facts.orderName} has not been dispatched, so the address CAN still be changed.\n` +
      `Collect the FULL new address first - street, city and country at minimum, plus postal code where it applies - and read it back to them.\n` +
      `Then call shopify.update_order_shipping_address with order_name "${facts.orderName}" and the address object. Approval is raised by calling the tool.\n` +
      `Report only what changed_fields confirms; if verified is false, say it did not go through.` };
}

// ─── Registry ───────────────────────────────────────────────

/**
 * Resolve the turn's critical-flow facts, if the turn is one.
 *
 * Returns `not_applicable` for everything else, which is most turns - this runs
 * two or three provider reads and must not be spent on "where is my order".
 */
export async function runFlowController(ctx: FlowContext): Promise<FlowDecision> {
  const msg = ctx.message ?? "";
  try {
    // Order matters: an exchange request usually also mentions returning, and a
    // return request rarely mentions exchanging.
    if (detectExchangeIntent(msg)) return await exchangeFlow(ctx);
    if (detectReturnIntent(msg)) return await returnFlow(ctx);
    if (detectOrderAddressIntent(msg)) return await addressFlow(ctx);
  } catch (err: any) {
    console.warn("[flow-controller] resolution failed (non-fatal):", err?.message);
    return { kind: "not_applicable" };
  }
  void detectMissingItemIntent;
  void detectProfileUpdateIntent;
  return { kind: "not_applicable" };
}

/**
 * The block the model sees. Facts first, then the single permitted move.
 *
 * `need_input` and `blocked` both say "call NOTHING" explicitly, because the
 * failure being prevented is not a wrong answer - it is a tool call made with
 * facts the model filled in itself.
 */
export function renderFlowDirective(d: FlowDecision): string | null {
  if (d.kind === "not_applicable") return null;
  const header =
    d.kind === "ready"
      ? "# RESOLVED FLOW - the facts below are verified; use them, do not re-derive them"
      : "# RESOLVED FLOW - do not call any tool for this request yet";
  return `${header}\n${d.directive}`;
}

/**
 * Dispatch-time gate: does this call match what the controller resolved?
 *
 * The directive tells the model what to do; this makes it true. A critical tool
 * called with arguments the controller did not compute is refused outright,
 * because that is the shape of every expensive mistake in Parts 1-5 - an
 * approval raised for an exchange with no variant, a refund against a stale
 * order, a cancel of the wrong one.
 */
export function assertMatchesResolvedFlow(
  decision: FlowDecision | null,
  toolName: string,
  args: Record<string, any>,
): { ok: true } | { ok: false; reason: string } {
  if (!decision || decision.kind === "not_applicable") return { ok: true };
  const critical = decision.kind === "ready" ? decision.tool : null;

  // The controller said "ask, do not act". Any critical tool call is premature.
  if (decision.kind !== "ready") {
    if (CRITICAL_TOOLS.some((t) => toolName.endsWith(t))) {
      return { ok: false, reason: `flow_not_ready: the required facts for this request are not resolved yet - ${decision.kind === "need_input" ? `ask the customer for ${decision.ask}` : "this request cannot proceed"}. Do not call ${toolName}.` };
    }
    return { ok: true };
  }

  if (!critical || !toolName.endsWith(critical.slice(critical.indexOf(".") + 1))) return { ok: true };

  for (const [k, v] of Object.entries(decision.args)) {
    if (v == null) continue;
    const got = args?.[k];
    if (got == null) {
      return { ok: false, reason: `flow_argument_missing:${k} - the resolved value is ${JSON.stringify(v)}. Call ${toolName} with exactly the arguments given.` };
    }
    if (String(got) !== String(v)) {
      return { ok: false, reason: `flow_argument_mismatch:${k} - resolved ${JSON.stringify(v)}, received ${JSON.stringify(got)}. The resolved value is the verified one; do not substitute your own.` };
    }
  }
  return { ok: true };
}

/** Tools whose misuse is irreversible or spends a human decision. */
export const CRITICAL_TOOLS = [
  ".cancel_order",
  ".process_refund",
  ".exchange_order_item",
  ".create_return",
  ".update_order_shipping_address",
];
