/**
 * ★ What a tool call leaves on the message: enough to answer "why was the
 * order not found?", never the customer's data.
 */
import { describe, it, expect } from "vitest";
import { toolCallRecord } from "../tool-call-record";

describe("★ toolCallRecord", () => {
  it("emails and phones masked; ids, numbers and short words kept; a list's count", () => {
    expect(toolCallRecord({
      tool: "woocommerce.list_customer_orders", decision: "executed",
      args: { email: "matanam0012@gmail.com", phone: "+972 54-568-0665", per_page: 10, status: "any" },
      result: JSON.stringify({ ok: true, result: [{ id: 575, billing: { email: "x@y.z" } }] }),
    })).toEqual({
      tool: "woocommerce.list_customer_orders", decision: "executed",
      args: { email: "m***@gmail.com", phone: "***0665", per_page: 10, status: "any" },
      resultCount: 1,
    });
  });

  it("an order id stays; long text and nested values are summarised; a failure keeps its reason", () => {
    const r = toolCallRecord({
      tool: "woocommerce.get_order", args: { order_id: "575", note: "x".repeat(200), filter: { a: 1 } },
      result: JSON.stringify({ ok: false, reason: "access_denied_cross_customer: the requested record belongs to a different customer." }),
    });
    expect(r.args).toEqual({ order_id: "575", note: "[200 chars]", filter: "[value]" });
    expect(r.resultError).toMatch(/^access_denied_cross_customer/);
    expect(JSON.stringify(r)).not.toContain("x@y.z");
  });

  it("★ the payload never rides along", () => {
    const r = toolCallRecord({ tool: "woocommerce.get_order", args: {}, result: JSON.stringify({ id: 575, billing: { email: "secret@x.com", phone: "0545680665" } }) });
    expect(JSON.stringify(r)).not.toMatch(/secret|0545680665/);
  });
});

describe("an order id is not a phone", () => {
  it("long numeric ids stay; a phone by name or shape is masked", () => {
    const r = toolCallRecord({ tool: "shopify.get_order", args: { order_id: "6123456789012", query: "0545680665", to: "+972545680665", customer_phone: 545680665 } });
    expect(r.args).toEqual({ order_id: "6123456789012", query: "***0665", to: "***0665", customer_phone: "***0665" });
  });
});
