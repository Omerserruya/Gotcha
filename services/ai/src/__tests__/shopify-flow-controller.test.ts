/**
 * The irreversible flows, decided by code.
 *
 * Part 5 ended with the mechanisms stronger than the behaviour they contained.
 * The two failures worth naming, both live:
 *
 *   - a human approved `shopify.exchange_order_item` called with
 *     `{quantity: 1, order_name: "1012"}` - an exchange with nothing to
 *     exchange TO. Every guard downstream was satisfied; the decision was spent
 *     on nothing and the tool failed with variant_not_found.
 *   - asked to swap a colour, the model called `variant_information` with a
 *     product name guessed from the customer's word for the item, landed on a
 *     different single-variant snowboard, and told the customer their product
 *     came in one version only. The order in front of it held five colours.
 *
 * Neither is possible when the model does not choose the move. These tests hold
 * that: the controller resolves order, line, options, price and eligibility
 * itself, and the dispatch gate refuses anything it did not compute.
 */
import { describe, it, expect, vi } from "vitest";
import {
  runFlowController,
  assertMatchesResolvedFlow,
  matchRequestedOption,
  orderNameFromMessage,
  returnReasonFromMessage,
  quantityFromMessage,
  renderFlowDirective,
  type FlowDecision,
} from "../services/shopify-flow-controller.service";

const COMPLETE_SNOWBOARD = {
  id: 45668848599409, product_id: 15889981964657, variant_id: 64158270849393,
  title: "The Complete Snowboard", variant_title: "Ice", quantity: 2, price: "699.95",
};
const OPTIONS = {
  has_variant_options: true,
  variants: [
    { variant_id: 64158270849393, title: "Ice", price: "699.95", in_stock: true, inventory_quantity: 10 },
    { variant_id: 64158270882161, title: "Dawn", price: "699.95", in_stock: true, inventory_quantity: 9 },
    { variant_id: 64158270914929, title: "Powder", price: "799.95", in_stock: true, inventory_quantity: 9 },
    { variant_id: 64158270947697, title: "Sunset", price: "699.95", in_stock: false, inventory_quantity: 0 },
  ],
};

function makeCall(over: Record<string, any> = {}) {
  return vi.fn(async (tool: string, args: any) => {
    if (tool === "shopify.get_order") {
      if (over.order === null) throw new Error("order_not_found");
      return over.order ?? { id: 16993113211249, name: "#1012", currency: "USD", line_items: [COMPLETE_SNOWBOARD], fulfillments: [] };
    }
    if (tool === "shopify.get_fulfillment_status") {
      return over.fulfillment ?? { fulfillment_orders: [{ id: 1, status: "open" }], fulfillment_orders_readable: true };
    }
    if (tool === "shopify.variant_information") return over.options ?? OPTIONS;
    if (tool === "shopify.get_returns") return over.returns ?? { returns: [] };
    throw new Error(`unexpected tool ${tool}`);
  });
}

const TOOLS = [
  "shopify.exchange_order_item", "shopify.create_return",
  "shopify.update_order_shipping_address", "shopify.variant_information", "shopify.get_order",
];

const ctx = (message: string, over: Record<string, any> = {}) => ({
  message, anchoredOrderName: over.anchor ?? null, availableTools: over.tools ?? TOOLS, call: makeCall(over),
});

describe("exchange: every fact resolved before the model speaks", () => {
  it("resolves order, line, option and price into one permitted call", async () => {
    const d = await runFlowController(ctx("בהזמנה 1012 אני רוצה להחליף יחידה אחת לגוון Dawn"));
    expect(d.kind).toBe("ready");
    if (d.kind !== "ready") return;
    expect(d.tool).toBe("shopify.exchange_order_item");
    expect(d.args).toEqual({
      order_name: "#1012",
      line_item_id: String(COMPLETE_SNOWBOARD.id),
      new_variant_id: "64158270882161",
      quantity: 1,
    });
    expect(d.facts.quote?.price_difference).toBe("0.00");
  });

  it("options come from the product ON THE ORDER LINE, never from a search", async () => {
    const call = makeCall();
    await runFlowController({ ...ctx("החלף לגוון Dawn בהזמנה 1012"), call });
    const variantCall = call.mock.calls.find((c) => c[0] === "shopify.variant_information");
    expect(variantCall?.[1]).toEqual({ product_id: String(COMPLETE_SNOWBOARD.product_id) });
    expect(call.mock.calls.some((c) => c[0] === "shopify.search_products")).toBe(false);
  });

  it("the live failure: no option named means ASK, never call", async () => {
    const d = await runFlowController(ctx("בהזמנה 1012 אני רוצה להחליף את הסנואורד"));
    expect(d.kind).toBe("need_input");
    if (d.kind !== "need_input") return;
    expect(d.directive).toContain("Ice");
    expect(d.directive).toContain("Dawn");
    expect(d.directive).toContain("Sunset (out of stock)");
    expect(d.directive).toContain("call NOTHING");
  });

  it("no order named means ASK, never guess", async () => {
    const d = await runFlowController(ctx("אני רוצה להחליף לגוון Dawn"));
    expect(d.kind).toBe("need_input");
    if (d.kind !== "need_input") return;
    expect(d.ask).toBe("which order");
  });

  it("uses the conversation's anchored order only when the customer names none", async () => {
    const d = await runFlowController(ctx("אני רוצה להחליף לגוון Dawn", { anchor: "#1012" }));
    expect(d.kind).toBe("ready");
  });

  it("a dearer option is blocked with the exact difference, and no coupon offered", async () => {
    // No quantity stated, so the whole line is quoted: 2 x (799.95 - 699.95).
    const d = await runFlowController(ctx("בהזמנה 1012 להחליף לגוון Powder"));
    expect(d.kind).toBe("blocked");
    if (d.kind !== "blocked") return;
    expect(d.facts.quote?.price_difference).toBe("200.00");
    expect(d.directive).toContain("Do NOT offer a discount, a coupon or a free upgrade");
  });

  it("a stated quantity is the one quoted", async () => {
    const d = await runFlowController(ctx("בהזמנה 1012 להחליף יחידה אחת לגוון Powder"));
    expect(d.kind).toBe("blocked");
    if (d.kind !== "blocked") return;
    expect(d.facts.quote?.price_difference).toBe("100.00");
  });

  it("an out-of-stock option is blocked before any approval", async () => {
    const d = await runFlowController(ctx("בהזמנה 1012 להחליף לגוון Sunset"));
    expect(d.kind).toBe("blocked");
  });

  it("a product with one version only is blocked, and no search is suggested", async () => {
    const d = await runFlowController(ctx("בהזמנה 1012 להחליף לגוון Dawn", {
      options: { has_variant_options: false, variants: [{ variant_id: 1, title: "Default Title", price: "1", in_stock: true }] },
    }));
    expect(d.kind).toBe("blocked");
    if (d.kind !== "blocked") return;
    expect(d.directive).toContain("sold in one version only");
    expect(d.directive).toContain("Do NOT run a product search");
  });

  it("fulfillment in progress routes to a return, not to an edit", async () => {
    const d = await runFlowController(ctx("בהזמנה 1012 להחליף לגוון Dawn", {
      fulfillment: { fulfillment_orders: [{ id: 1, status: "in_progress" }], fulfillment_orders_readable: true },
    }));
    expect(d.kind).toBe("blocked");
    if (d.kind !== "blocked") return;
    expect(d.directive).toContain("RETURN plus a replacement");
  });

  it("an unreadable fulfillment scope never proceeds to an edit", async () => {
    const d = await runFlowController(ctx("בהזמנה 1012 להחליף לגוון Dawn", {
      fulfillment: { fulfillment_orders: [], fulfillment_orders_readable: false },
    }));
    expect(d.kind).toBe("blocked");
  });

  it("a multi-item order asks which item", async () => {
    const d = await runFlowController(ctx("בהזמנה 1012 להחליף לגוון Dawn", {
      order: { id: 1, name: "#1012", currency: "USD", fulfillments: [], line_items: [COMPLETE_SNOWBOARD, { ...COMPLETE_SNOWBOARD, id: 2, title: "Boots" }] },
    }));
    expect(d.kind).toBe("need_input");
    if (d.kind !== "need_input") return;
    expect(d.ask).toBe("which item");
  });

  it("without the tool it blocks and offers no coupon", async () => {
    const d = await runFlowController(ctx("בהזמנה 1012 להחליף לגוון Dawn", { tools: [] }));
    expect(d.kind).toBe("blocked");
    if (d.kind !== "blocked") return;
    expect(d.directive).toContain("do NOT offer a coupon or discount");
  });
});

describe("the dispatch gate makes the decision binding", () => {
  const ready: FlowDecision = {
    kind: "ready", intent: "exchange", facts: { intent: "exchange" },
    tool: "shopify.exchange_order_item",
    args: { order_name: "#1012", line_item_id: "45668848599409", new_variant_id: "64158270882161", quantity: 1 },
    directive: "",
  };

  it("allows the exact call the controller computed", () => {
    expect(assertMatchesResolvedFlow(ready, "shopify.exchange_order_item", { ...ready.args }).ok).toBe(true);
  });

  it("refuses the live failure verbatim - `{quantity, order_name}` and nothing else", () => {
    const v = assertMatchesResolvedFlow(ready, "shopify.exchange_order_item", { order_name: "#1012", quantity: 1 });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toContain("flow_argument_missing");
  });

  it("names the missing replacement variant when that is the only gap", () => {
    const v = assertMatchesResolvedFlow(ready, "shopify.exchange_order_item", {
      order_name: "#1012", line_item_id: "45668848599409", quantity: 1,
    });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toContain("flow_argument_missing:new_variant_id");
  });

  it("refuses a substituted variant", () => {
    const v = assertMatchesResolvedFlow(ready, "shopify.exchange_order_item", { ...ready.args, new_variant_id: "99" });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toContain("flow_argument_mismatch:new_variant_id");
  });

  it("refuses a switched order", () => {
    const v = assertMatchesResolvedFlow(ready, "shopify.exchange_order_item", { ...ready.args, order_name: "#1006" });
    expect(v.ok).toBe(false);
  });

  it("refuses ANY critical tool while the controller is still asking", () => {
    const asking: FlowDecision = { kind: "need_input", intent: "exchange", facts: { intent: "exchange" }, ask: "which option", directive: "" };
    for (const t of ["shopify.cancel_order", "shopify.process_refund", "shopify.create_return", "shopify.exchange_order_item", "shopify.update_order_shipping_address"]) {
      const v = assertMatchesResolvedFlow(asking, t, {});
      expect(v.ok, t).toBe(false);
      if (!v.ok) expect(v.reason).toContain("flow_not_ready");
    }
  });

  it("leaves reads alone while the controller is asking", () => {
    const asking: FlowDecision = { kind: "need_input", intent: "exchange", facts: { intent: "exchange" }, ask: "x", directive: "" };
    expect(assertMatchesResolvedFlow(asking, "shopify.get_order", {}).ok).toBe(true);
  });

  it("does not police turns the controller did not claim", () => {
    expect(assertMatchesResolvedFlow(null, "shopify.process_refund", {}).ok).toBe(true);
    expect(assertMatchesResolvedFlow({ kind: "not_applicable" }, "shopify.cancel_order", {}).ok).toBe(true);
  });
});

describe("return flow", () => {
  const FULFILLED = {
    id: 16943013298545, name: "#1003", currency: "USD",
    line_items: [{ id: 45571993928049, title: "The Hidden Snowboard", quantity: 1, price: "749.95" }],
    fulfillments: [{ id: 6904011129201, status: "success" }],
  };

  it("an unfulfilled order is blocked before any approval", async () => {
    const d = await runFlowController(ctx("המוצר בהזמנה 1012 הגיע פגום, אני רוצה להחזיר"));
    expect(d.kind).toBe("blocked");
    if (d.kind !== "blocked") return;
    expect(d.directive).toContain("nothing to return");
  });

  it("a fulfilled order with no open return is ready, with the reason mapped", async () => {
    const d = await runFlowController(ctx("המוצר בהזמנה 1003 הגיע פגום, אני רוצה להחזיר אותו", { order: FULFILLED }));
    expect(d.kind).toBe("ready");
    if (d.kind !== "ready") return;
    expect(d.tool).toBe("shopify.create_return");
    expect(d.args).toEqual({ order_name: "#1003", reason: "DEFECTIVE" });
    expect(d.directive).toContain("return_created: true");
  });

  it("an already-open return blocks a second one", async () => {
    const d = await runFlowController(ctx("להחזיר את ההזמנה 1003", {
      order: FULFILLED, returns: { returns: [{ id: "gid://shopify/Return/1", status: "OPEN" }] },
    }));
    expect(d.kind).toBe("blocked");
    if (d.kind !== "blocked") return;
    expect(d.directive).toContain("ALREADY open");
  });

  it("with no return tool it must not claim a case was opened", async () => {
    const d = await runFlowController(ctx("להחזיר את ההזמנה 1003", { order: FULFILLED, tools: [] }));
    expect(d.kind).toBe("blocked");
    if (d.kind !== "blocked") return;
    expect(d.directive).toContain("must NOT say a return, RMA or case was opened");
  });
});

describe("address flow", () => {
  it("an eligible order asks for the full address, and says the change is possible", async () => {
    const d = await runFlowController(ctx("אפשר לשנות את כתובת המשלוח בהזמנה 1012?"));
    expect(d.kind).toBe("need_input");
    if (d.kind !== "need_input") return;
    expect(d.directive).toContain("CAN still be changed");
    expect(d.directive).toContain("FULL new address");
  });

  it("a dispatched order refuses, and forbids the carrier claim", async () => {
    const d = await runFlowController(ctx("אפשר לשנות את כתובת המשלוח בהזמנה 1012?", {
      fulfillment: { fulfillment_orders: [{ id: 1, status: "in_progress" }], fulfillment_orders_readable: true },
    }));
    expect(d.kind).toBe("blocked");
    if (d.kind !== "blocked") return;
    expect(d.directive).toContain("do NOT say the carrier, courier or warehouse has been contacted");
  });
});

describe("the small deterministic readers", () => {
  it("reads an order number the customer typed, and only that", () => {
    expect(orderNameFromMessage("בהזמנה 1012 יש בעיה")).toBe("#1012");
    expect(orderNameFromMessage("order #1003 please")).toBe("#1003");
    expect(orderNameFromMessage("אני רוצה להחליף מידה")).toBeNull();
    expect(orderNameFromMessage("יש לי 2 פריטים")).toBeNull();
  });

  it("matches an option by its real title, longest first", () => {
    const opts = [
      { variant_id: "1", title: "Ice", price: "1", in_stock: true, available: 1 },
      { variant_id: "2", title: "Ice Blue", price: "1", in_stock: true, available: 1 },
    ];
    expect(matchRequestedOption("אני רוצה Ice Blue", opts, "9")?.variant_id).toBe("2");
  });

  it("never matches the variant already on the order", () => {
    const opts = [{ variant_id: "1", title: "Ice", price: "1", in_stock: true, available: 1 }];
    expect(matchRequestedOption("להחליף ל Ice", opts, "1")).toBeNull();
  });

  it("ignores Shopify's placeholder option title", () => {
    const opts = [{ variant_id: "1", title: "Default Title", price: "1", in_stock: true, available: 1 }];
    expect(matchRequestedOption("default title", opts, "9")).toBeNull();
  });

  it("maps what the customer said to a real ReturnReason", () => {
    expect(returnReasonFromMessage("הגיע פגום")).toBe("DEFECTIVE");
    expect(returnReasonFromMessage("wrong item")).toBe("WRONG_ITEM");
    expect(returnReasonFromMessage("התחרטתי")).toBe("UNWANTED");
    expect(returnReasonFromMessage("סתם")).toBe("UNKNOWN");
  });

  it("reads a quantity only when one is stated", () => {
    expect(quantityFromMessage("יחידה אחת")).toBe(1);
    expect(quantityFromMessage("2 יחידות")).toBe(2);
    expect(quantityFromMessage("להחליף לגוון Dawn")).toBeNull();
  });

  it("renders nothing for a turn it does not claim", () => {
    expect(renderFlowDirective({ kind: "not_applicable" })).toBeNull();
  });
});
