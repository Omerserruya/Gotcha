import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A human must never be asked to approve an action with no parameters.
 *
 * On 2026-07-31 the model called `shopify.cancel_order` with `{}` - no order
 * id, no order name. The gate correctly saw a HIGH-risk tool and raised an
 * approval. The inbox showed `shopify.cancel_order()`, a human approved it at
 * 14:22:53, and execution then failed with `order_id_or_name_required`.
 * `execution_state` went to FAILED and the customer, who had been told "I'm
 * handling your cancellation now", waited and asked twice what was happening
 * before an agent took over.
 *
 * An approval is a person taking responsibility for a specific action. With no
 * parameters there is nothing to take responsibility FOR, and the only possible
 * outcome is a failure discovered after someone has already said yes. The
 * schema fix (anyOf on the destructive order tools) stops the model making the
 * call; this stops the approval ever being created if it does.
 */

const H = vi.hoisted(() => ({
  created: [] as Array<{ tool: string; params: unknown }>,
  gateDecision: "REQUIRE_APPROVAL" as string,
}));

vi.mock("../tool-gate", () => ({
  evaluateToolGate: async () => ({ decision: H.gateDecision, reason: "high risk tool" }),
}));

vi.mock("../approval-requests", () => ({
  createApprovalRequest: async (input: any) => {
    H.created.push({ tool: input.tool, params: input.params });
    return { id: "appr_1" };
  },
}));

vi.mock("../prisma", () => ({
  prisma: {
    approvalRequest: { findFirst: async () => null },
    tenantTool: { findFirst: async () => null },
  },
}));

import { dispatchToolCall } from "../agent-tools";
import { __resetToolAttemptGuard } from "../tool-attempt-guard";

const CTX = { tenantId: "tnt_1", conversationId: "conv_1" } as any;
const call = (name: string, args: Record<string, unknown>) => ({
  id: `call_${name}`,
  function: { name, arguments: JSON.stringify(args) },
});

beforeEach(() => {
  H.created.length = 0;
  H.gateDecision = "REQUIRE_APPROVAL";
  // The repeat-failure guard is live in this path and counts these refusals.
  // Without a reset the third argument-less call in this file would be blocked
  // as a repeat rather than by the check under test - which is the two guards
  // composing correctly, and is asserted deliberately at the end.
  __resetToolAttemptGuard();
});

describe("an approval is never created for an argument-less call", () => {
  it("refuses the exact call that failed - cancel_order with {}", async () => {
    const r = await dispatchToolCall(call("shopify.cancel_order", {}), CTX);
    const payload = JSON.parse(r.content);

    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("missing_arguments");
    expect(H.created, "no approval row may be created").toEqual([]);
  });

  it("tells the model what to do instead, in terms it can act on", async () => {
    const r = await dispatchToolCall(call("shopify.cancel_order", {}), CTX);
    const instruction = String(JSON.parse(r.content).instruction);

    expect(instruction).toMatch(/needs its target parameters/i);
    expect(instruction).toMatch(/order number/i);
    // The other half of the incident: the bot announced the cancellation was
    // under way before anything had succeeded.
    expect(instruction).toMatch(/Do not tell the customer the action is in progress/i);
  });

  it("records the refusal as a denial, so it is visible in the turn log", async () => {
    const r = await dispatchToolCall(call("shopify.cancel_order", {}), CTX);
    expect(r.sideEffect?.denied?.reason).toBe("approval_requested_with_no_arguments");
  });
});

describe("a properly-targeted call still raises an approval", () => {
  it("creates the approval when the order is named", async () => {
    // The guard must not make destructive actions unreachable - it only
    // requires that someone can see WHAT is being approved.
    const r = await dispatchToolCall(
      call("shopify.cancel_order", { order_name: "#1006", reason: "customer" }),
      CTX,
    );
    const payload = JSON.parse(r.content);

    expect(payload.awaiting_approval).toBe(true);
    expect(H.created).toHaveLength(1);
    expect(H.created[0].params).toMatchObject({ order_name: "#1006" });
  });

  it("passes the parameters through so the inbox can show them", async () => {
    // `shopify.cancel_order()` told the approver nothing. The params are what
    // make the decision a real one.
    await dispatchToolCall(call("shopify.cancel_order", { order_id: "5678901234567" }), CTX);
    expect(H.created[0].params).toMatchObject({ order_id: "5678901234567" });
  });

  it("a single meaningful argument is enough", async () => {
    await dispatchToolCall(call("shopify.cancel_order", { order_name: "1006" }), CTX);
    expect(H.created).toHaveLength(1);
  });
});

describe("the two guards compose", () => {
  // The missing-arguments refusal is a failure like any other, so a model that
  // ignores the instruction and calls again with `{}` hits the repeat brake.
  // The customer is spared both the pointless approval AND the loop.
  it("stops the third identical argument-less call", async () => {
    __resetToolAttemptGuard();
    const results: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await dispatchToolCall(call("shopify.cancel_order", {}), CTX);
      results.push(JSON.parse(r.content).error);
    }
    expect(results[0]).toBe("missing_arguments");
    expect(results[1]).toBe("missing_arguments");
    // The third is caught earlier, by the repeat brake.
    expect(results[2]).toMatch(/already failed|Do not call it again/i);
    expect(H.created, "still no approval was ever created").toEqual([]);
  });
});
