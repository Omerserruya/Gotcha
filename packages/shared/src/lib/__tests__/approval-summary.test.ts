import { describe, it, expect } from "vitest";
import { describeApprovalAction } from "../approval-requests";

/**
 * The sentence an operator reads while deciding whether to move money.
 *
 * ★ 27 of 54 approval rows in dev said "ai-bot inbox tool call" - the caller's
 * own debug breadcrumb, landing in the one field that describes the act. Nine
 * more said "issue_refund()". The column is a plain `String` with one writer and
 * six callers, so five conventions coexisted and nothing could notice.
 *
 * ★★ EVERY CASE BELOW USES A TOOL AND PARAMETER SET TAKEN FROM THE DATABASE,
 * not invented: `order_name` appears on 7 of the 9 distinct tools that reach
 * approval, `amount` only on refunds, `subject` on tasks. A test written against
 * guessed keys would pass while the real rows stayed unreadable.
 */
describe("describeApprovalAction", () => {
  it("names the act, for the tools that actually reach approval", () => {
    expect(describeApprovalAction("shopify.cancel_order", { order_name: "#1006", reason: "customer" }))
      .toBe("Cancel order #1006");
    expect(describeApprovalAction("shopify.resend_confirmation", { order_name: "#1006" }))
      .toBe("Resend confirmation for order #1006");
    expect(describeApprovalAction("create_task", { subject: "Follow up with Dana", contact_id: "c1" }))
      .toBe("Create task: Follow up with Dana");
  });

  it("drops the provider, because that is not what is being decided", () => {
    // `shopify.`, `integration_` and a nested `integration.hubspot.` all name an
    // action; the approver is deciding about the action.
    expect(describeApprovalAction("integration_cancel_order", { order_name: "#77" })).toBe("Cancel order #77");
    expect(describeApprovalAction("integration.hubspot.create_deal", { name: "Acme" })).toBe("Create deal: Acme");
  });

  it("carries the refund amount and INVENTS NO CURRENCY", () => {
    const s = describeApprovalAction("shopify.process_refund", { amount: 179, order_name: "#1006", notify: true });
    expect(s).toBe("Process refund of 179 for order #1006");
    // The params hold a bare number and no unit. A symbol here would be fiction,
    // and fiction on a money screen is worse than an absent detail.
    expect(s).not.toMatch(/[₪$€£]/);
  });

  it("never emits a function signature or a parameter dump", () => {
    // This is the "issue_refund()" regression, stated as a property.
    for (const [tool, params] of [
      ["issue_refund", {}],
      ["shopify.process_refund", { amount: 20, note: "x", refund: true }],
      ["shopify.exchange_order_item", { order_name: "#9", line_item_id: "li_1", quantity: 2 }],
    ] as Array<[string, Record<string, unknown>]>) {
      const s = describeApprovalAction(tool, params);
      expect(s).not.toContain("(");
      expect(s).not.toContain("=");
      expect(s).not.toContain("{");
    }
  });

  it("reads as a description, not as an instruction", () => {
    // One producer prefixed "Approve: ", which made its rows disagree with the
    // other two about what this field is.
    expect(describeApprovalAction("shopify.create_return", { order_name: "#5" })).not.toMatch(/^Approve:/);
  });

  it("degrades to something honest rather than to a placeholder", () => {
    expect(describeApprovalAction("issue_refund", {})).toBe("Issue refund");
    expect(describeApprovalAction("", {})).toBe("Approve this action");
    // Empty strings and non-scalars are not details.
    expect(describeApprovalAction("shopify.cancel_order", { order_name: "  " })).toBe("Cancel order");
    expect(describeApprovalAction("create_task", { subject: { nested: true } })).toBe("Create task");
  });

  it("is TOTAL - it cannot throw, because it is called inside a permission gate", () => {
    // The call site sits inside `agent-tools`'s gate try/catch, whose catch
    // refuses the tool: "permission gate unavailable; refusing to run tool".
    // Failing closed is the right direction, but refusing a customer's action
    // because a LABEL could not be built would be a bad trade. So this is
    // proven total rather than defended with a wrapper that would be dead code.
    const hostile: unknown[] = [
      undefined, null, 0, "", "  ", [], {}, { order_name: null }, { order_name: [1, 2] },
      { subject: Symbol("s") }, { amount: NaN }, { amount: Infinity }, { amount: "12" },
      Object.create(null),
    ];
    for (const params of hostile) {
      for (const tool of ["", ".", "_", "a.b.c", "shopify.", "integration_", "x".repeat(300)]) {
        expect(() => describeApprovalAction(tool, params as Record<string, unknown>)).not.toThrow();
        expect(typeof describeApprovalAction(tool, params as Record<string, unknown>)).toBe("string");
      }
    }
  });

  it("cannot reproduce the placeholder, whatever it is given", () => {
    // The structural fix: this function has no parameter through which a
    // caller's rationale could arrive, so "ai-bot inbox tool call" is not
    // expressible here.
    const s = describeApprovalAction("shopify.process_refund", {
      rationale: "ai-bot inbox tool call",
      order_name: "#1006",
    });
    expect(s).not.toContain("ai-bot");
    expect(s).toBe("Process refund for order #1006");
  });
});
