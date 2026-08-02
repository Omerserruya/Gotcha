/**
 * Swapping a line item for a different variant, before anything ships.
 *
 * The interesting constraint is money, not mechanics. A Shopify order edit does
 * not settle itself: a dearer variant leaves the order owing, a cheaper one
 * leaves the shop owing, and there is no customer-facing payment flow here to
 * close either gap. Both are refused BEFORE the edit begins - an aborted order
 * edit is worse than none - and the refusal has to survive, because "I'll give
 * you a discount to cover the difference" is precisely what a blocked model
 * improvises.
 */
import { describe, it, expect } from "vitest";
import { quoteExchange, verifyExchange, type ExchangeQuote } from "../services/connectors/shopify-exchange";
import {
  detectExchangeIntent,
  buildExchangeDirective,
} from "../services/customer-request-intents.service";

const line = (over: Record<string, unknown> = {}) => ({
  id: 101, variant_id: 5001, title: "The Minimal Snowboard", variant_title: "156",
  price: "749.95", quantity: 1, ...over,
});
const variant = (over: Record<string, unknown> = {}) => ({
  id: 5002, title: "159", price: "749.95", inventory_management: "shopify", inventory_quantity: 4, ...over,
});

function quote(over: { lineItem?: any; variant?: any; quantity?: number } = {}) {
  return quoteExchange({
    orderName: "#1011",
    currency: "USD",
    lineItem: over.lineItem === undefined ? line() : over.lineItem,
    variant: over.variant === undefined ? variant() : over.variant,
    productTitle: "The Minimal Snowboard",
    quantity: over.quantity ?? 1,
  });
}

describe("a same-price exchange is the one that can complete", () => {
  it("quotes a size swap at the same price as eligible", () => {
    const q = quote();
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    expect(q.quote.relation).toBe("equal");
    expect(q.quote.price_difference).toBe("0.00");
    expect(q.quote.current_variant).toBe("156");
    expect(q.quote.requested_variant).toBe("159");
  });

  it("carries everything the approval card has to show", () => {
    const q = quote();
    if (!q.ok) throw new Error("expected eligible");
    for (const k of [
      "order_name", "current_title", "current_variant", "current_unit_price",
      "requested_title", "requested_variant", "requested_unit_price",
      "quantity", "currency", "price_difference", "inventory_available",
    ]) {
      expect(q.quote, k).toHaveProperty(k);
    }
  });

  it("treats a floating-point zero as equal", () => {
    const q = quote({ lineItem: line({ price: "749.95" }), variant: variant({ price: "749.950" }) });
    expect(q.ok).toBe(true);
  });
});

describe("money stops the exchange, before anything is written", () => {
  it("a dearer replacement is refused with the exact difference", () => {
    const q = quote({ variant: variant({ price: "799.95" }) });
    expect(q.ok).toBe(false);
    if (q.ok) return;
    expect(q.reason).toBe("price_difference_requires_payment");
    expect(q.quote?.price_difference).toBe("50.00");
  });

  it("a cheaper replacement is refused too - the shop would owe money", () => {
    const q = quote({ variant: variant({ price: "699.95" }) });
    expect(q.ok).toBe(false);
    if (q.ok) return;
    expect(q.reason).toBe("price_difference_requires_refund");
    expect(q.quote?.price_difference).toBe("-50.00");
  });

  it("multiplies the difference by the quantity being swapped", () => {
    const q = quote({
      lineItem: line({ quantity: 2 }),
      variant: variant({ price: "799.95" }),
      quantity: 2,
    });
    if (q.ok) throw new Error("expected refusal");
    expect(q.quote?.price_difference).toBe("100.00");
  });

  it("an unreadable price never auto-commits", () => {
    const q = quote({ variant: variant({ price: null }) });
    expect(q.ok).toBe(false);
  });
});

describe("stock, quantity and the other refusals", () => {
  it("refuses a tracked variant with nothing on the shelf", () => {
    const q = quote({ variant: variant({ inventory_quantity: 0 }) });
    if (q.ok) throw new Error("expected refusal");
    expect(q.reason).toBe("out_of_stock");
  });

  it("allows an UNTRACKED variant - absent tracking is not absent stock", () => {
    const q = quote({ variant: variant({ inventory_management: null, inventory_quantity: 0 }) });
    expect(q.ok).toBe(true);
  });

  it("refuses more units than the order holds", () => {
    const q = quote({ lineItem: line({ quantity: 1 }), quantity: 2 });
    if (q.ok) throw new Error("expected refusal");
    expect(q.reason).toBe("insufficient_quantity");
  });

  it("refuses a zero or negative quantity", () => {
    for (const n of [0, -1]) {
      const q = quote({ quantity: n });
      if (q.ok) throw new Error("expected refusal");
      expect(q.reason).toBe("quantity_invalid");
    }
  });

  it("refuses a swap for the variant already on the order", () => {
    const q = quote({ variant: variant({ id: 5001 }) });
    if (q.ok) throw new Error("expected refusal");
    expect(q.reason).toBe("same_variant");
  });

  it("refuses an item that is not on the order at all", () => {
    const q = quote({ lineItem: null });
    if (q.ok) throw new Error("expected refusal");
    expect(q.reason).toBe("line_item_not_found");
  });

  it("refuses a variant that does not exist", () => {
    const q = quote({ variant: null });
    if (q.ok) throw new Error("expected refusal");
    expect(q.reason).toBe("variant_not_found");
  });

  it("allows exchanging one of two units", () => {
    const q = quote({ lineItem: line({ quantity: 2 }), quantity: 1 });
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    expect(q.quote.original_quantity).toBe(2);
    expect(q.quote.quantity).toBe(1);
  });
});

describe("verifying the committed edit", () => {
  const base = (): ExchangeQuote => {
    const q = quote();
    if (!q.ok) throw new Error("setup");
    return q.quote;
  };

  it("confirms a whole-line swap: new line present, old line gone", () => {
    const v = verifyExchange(base(), { line_items: [{ variant_id: 5002, quantity: 1 }] });
    expect(v.verified).toBe(true);
  });

  it("catches an edit that added the new line and left the old one", () => {
    const v = verifyExchange(base(), {
      line_items: [{ variant_id: 5001, quantity: 1 }, { variant_id: 5002, quantity: 1 }],
    });
    expect(v.verified).toBe(false);
    expect(v.problems.join()).toContain("original_quantity_1_expected_0");
  });

  it("catches an edit that removed the old line and never added the new one", () => {
    const v = verifyExchange(base(), { line_items: [] });
    expect(v.verified).toBe(false);
    expect(v.problems.join()).toContain("replacement_quantity_0_expected_1");
  });

  it("expects the remainder to survive a partial swap", () => {
    const q = quote({ lineItem: line({ quantity: 2 }), quantity: 1 });
    if (!q.ok) throw new Error("setup");
    const good = verifyExchange(q.quote, {
      line_items: [{ variant_id: 5001, quantity: 1 }, { variant_id: 5002, quantity: 1 }],
    });
    expect(good.verified).toBe(true);
    const bad = verifyExchange(q.quote, { line_items: [{ variant_id: 5002, quantity: 1 }] });
    expect(bad.verified).toBe(false);
  });
});

describe("the exchange directive", () => {
  it("fires on how customers ask", () => {
    for (const s of [
      "אפשר להחליף למידה 159?",
      "אני רוצה צבע אחר",
      "can I swap it for a different size?",
    ]) {
      expect(detectExchangeIntent(s), s).toBe(true);
    }
  });

  it("forbids every substitute for a price gap", () => {
    const d = buildExchangeDirective({ hasExchangeTool: true });
    expect(d).toContain("do NOT offer a coupon, a discount or a free upgrade");
    expect(d).toContain("do NOT promise a refund of the difference yourself");
    expect(d).toContain("do NOT invent store credit");
  });

  it("requires a real variant lookup before the swap", () => {
    const d = buildExchangeDirective({ hasExchangeTool: true });
    expect(d).toContain("call variant_information");
    expect(d).toContain("Do not guess at sizes or colours");
  });

  it("routes a dispatched order to a return, not to a claim", () => {
    const d = buildExchangeDirective({ hasExchangeTool: true });
    expect(d).toContain("RETURN plus a replacement");
    expect(d).toContain("do not claim anything was swapped");
  });

  it("gates the success sentence on the verified flag", () => {
    const d = buildExchangeDirective({ hasExchangeTool: true });
    expect(d).toContain("Only when exchange_completed is true");
  });

  it("without the tool it must not offer a coupon instead", () => {
    const d = buildExchangeDirective({ hasExchangeTool: false });
    expect(d).toContain("do NOT offer a coupon or discount as a substitute");
  });
});
