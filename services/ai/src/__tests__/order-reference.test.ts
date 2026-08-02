/**
 * Order anchoring: the customer's latest message wins.
 *
 * Live failure. Matan discussed #1006, a refund on it failed, and he wrote
 *
 *     "לא, שכח מ1006. אני מבקש החזר כספי מלא עבור ההזמנה מספר 1010 בלבד"
 *
 * The bot answered about #1006 anyway - through an explicit negation AND an
 * explicit re-selection, twice in a row. A model anchored on a long history
 * can walk a stale order into a refund, which is the one place a wrong answer
 * costs real money.
 *
 * The dangerous direction of a false positive here is the opposite of usual:
 * reading a number as an order when it is not one would fence a legitimate
 * action. "מידה 159" is a board length and "תחזירו לי 200 שקל" is money, so
 * bare digits must never be read as order references.
 */
import { describe, it, expect } from "vitest";
import {
  extractOrderReferences,
  assertOrderTargetMatchesTurn,
  isOrderStateChangingTool,
  normalizeOrderName,
} from "../services/order-reference.service";

const fence = (message: string, order: string) =>
  assertOrderTargetMatchesTurn({ message, args: { order_name: order }, isStateChanging: true });

describe("reading order references out of a message", () => {
  it("reads #1010", () => {
    expect(extractOrderReferences("מה קורה עם #1010?").explicit).toEqual(["1010"]);
  });

  it("reads a number that follows an order word", () => {
    expect(extractOrderReferences("אני רוצה לבטל את הזמנה 1009").explicit).toEqual(["1009"]);
    expect(extractOrderReferences("ההזמנה מספר 1010 בלבד").explicit).toContain("1010");
    expect(extractOrderReferences("cancel order 1009").explicit).toEqual(["1009"]);
  });

  it("does NOT read a size as an order", () => {
    expect(extractOrderReferences("יש את הדגם הזה במידה 159?").explicit).toEqual([]);
  });

  it("does NOT read an amount as an order", () => {
    expect(extractOrderReferences("תחזירו לי 200 שקל על הפריט הפגום").explicit).toEqual([]);
    expect(extractOrderReferences("יש סנובורד עד 2500 שקל?").explicit).toEqual([]);
  });

  it("separates a negated order from a selected one", () => {
    const s = extractOrderReferences("לא 1006, 1010");
    expect(s.negated).toContain("1006");
    expect(s.explicit).not.toContain("1006");
  });

  it("treats 'שכח מ-1006' as a negation and a context reset", () => {
    const s = extractOrderReferences("שכח מ-1006, תתייחס רק להזמנה 1010");
    expect(s.negated).toContain("1006");
    expect(s.explicit).toContain("1010");
    expect(s.resetsContext).toBe(true);
  });

  it("recognises a bare context reset with no numbers", () => {
    expect(extractOrderReferences("שכח מההזמנה הקודמת").resetsContext).toBe(true);
    expect(extractOrderReferences("forget the previous order").resetsContext).toBe(true);
  });

  it("recognises 'the latest order'", () => {
    expect(extractOrderReferences("מה הסטטוס של ההזמנה האחרונה שלי?").wantsLatest).toBe(true);
    expect(extractOrderReferences("what about my latest order").wantsLatest).toBe(true);
  });

  it("normalizes # and leading zeros", () => {
    expect(normalizeOrderName("#01010")).toBe("1010");
    expect(normalizeOrderName(1010)).toBe("1010");
  });
});

describe("fencing a financial action against the current message", () => {
  it("BLOCKS the live regression: refund on 1006 after 'שכח מ1006 ... 1010 בלבד'", () => {
    const v = fence("לא, שכח מ1006. אני מבקש החזר כספי מלא עבור ההזמנה מספר 1010 בלבד", "#1006");
    expect(v.ok).toBe(false);
    expect(v.expected).toContain("1010");
    expect(v.got).toBe("1006");
  });

  it("ALLOWS the same action against the order the customer named", () => {
    expect(fence("לא, שכח מ1006. אני מבקש החזר על ההזמנה מספר 1010 בלבד", "#1010").ok).toBe(true);
  });

  it("blocks an explicitly negated order even when no replacement is named", () => {
    const v = fence("לא 1006", "1006");
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/EXCLUDES/);
  });

  it("blocks a stale order when the message names a different one", () => {
    const v = fence("אני מדבר על #1010 בלבד", "#1006");
    expect(v.ok).toBe(false);
  });

  it("does NOT constrain a message that names no order", () => {
    // The customer said nothing about which order; the normal resolver owns it.
    expect(fence("כן, תמשיך", "#1006").ok).toBe(true);
    expect(fence("זה דחוף", "#1006").ok).toBe(true);
  });

  it("does not fence reads - only state changes", () => {
    const v = assertOrderTargetMatchesTurn({
      message: "אני מדבר על 1010 בלבד",
      args: { order_name: "#1006" },
      isStateChanging: false,
    });
    expect(v.ok).toBe(true);
  });

  it("allows an action when no order target is present at all", () => {
    expect(assertOrderTargetMatchesTurn({ message: "בטל", args: {}, isStateChanging: true }).ok).toBe(true);
  });

  it("handles two orders in one message by accepting either named one", () => {
    const msg = "מה עם הזמנות 1009 ו-1010?";
    expect(extractOrderReferences(msg).explicit).toEqual(expect.arrayContaining(["1009", "1010"]));
    expect(fence(msg, "1009").ok).toBe(true);
    expect(fence(msg, "1010").ok).toBe(true);
    expect(fence(msg, "1006").ok).toBe(false);
  });

  it("stays silent when numbers carry no order word at all", () => {
    // "מה עם 1009 ו-1010" could be anything - sizes, prices, quantities.
    // Nothing is claimed, so nothing is fenced and the resolver still owns it.
    expect(extractOrderReferences("מה עם 1009 ו-1010?").explicit).toEqual([]);
    expect(fence("מה עם 1009 ו-1010?", "1006").ok).toBe(true);
  });

  it("a size in the same message does not fence the named order", () => {
    // "159" must not be mistaken for an order and block a legitimate action.
    expect(fence("בטל את הזמנה 1010, המידה 159 לא מתאימה", "1010").ok).toBe(true);
  });
});

describe("which tools are fenced", () => {
  it("fences the money and cancellation tools", () => {
    for (const t of ["shopify.cancel_order", "shopify.process_refund", "shopify.send_invoice"]) {
      expect(isOrderStateChangingTool(t)).toBe(true);
    }
  });

  it("leaves reads alone", () => {
    for (const t of ["shopify.get_order", "shopify.track_shipment", "shopify.search_products"]) {
      expect(isOrderStateChangingTool(t)).toBe(false);
    }
  });
});
