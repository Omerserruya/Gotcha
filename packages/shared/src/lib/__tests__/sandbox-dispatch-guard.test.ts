import { describe, it, expect } from "vitest";
import { dispatchToolCall } from "../agent-tools";

/**
 * Proves the sandbox write guard at the dispatcher itself.
 *
 * The live acceptance run could not exercise this: asked for a refund, the
 * employee sensibly asked for confirmation first and never called a tool. So
 * the guarantee "a write cannot execute during a test conversation" has to be
 * proven here, where the decision is actually made, rather than by hoping a
 * language model reaches for a tool on cue.
 *
 * These calls hit the guard BEFORE any policy or database work, which is
 * exactly the property under test - a simulated write must not create an
 * approval request, notify anyone, or leave an audit record.
 */

const call = (name: string, args: Record<string, unknown> = {}) => ({
  id: `call_${name}`,
  function: { name, arguments: JSON.stringify(args) },
});

const SANDBOX_SAFE = {
  tenantId: "tnt_test",
  conversationId: "conv_test",
  sandbox: { enabled: true as const, writes: "safe" as const },
};

describe("sandbox write guard - a test conversation cannot change anything", () => {
  it("does NOT execute a refund, and says so in the result", async () => {
    const r = await dispatchToolCall(call("issue_refund", { orderId: "10042", amount: 250 }), SANDBOX_SAFE);
    const payload = JSON.parse(r.content);
    expect(payload.simulated).toBe(true);
    expect(payload.executed).toBe(false);
    expect(payload.tool).toBe("issue_refund");
    // The arguments come back so the UI can show what WOULD have happened.
    expect(payload.arguments).toMatchObject({ orderId: "10042", amount: 250 });
    expect(r.sideEffect?.simulated?.tool).toBe("issue_refund");
  });

  it("tells the model plainly not to claim the action happened", async () => {
    const r = await dispatchToolCall(call("issue_refund"), SANDBOX_SAFE);
    const note = String(JSON.parse(r.content).note);
    expect(note).toMatch(/SIMULATION/);
    expect(note).toMatch(/not performed/i);
    expect(note).toMatch(/Do not claim it is done/i);
  });

  it("blocks every mutating tool family, not just refunds", async () => {
    for (const tool of [
      "apply_discount", "send_message", "schedule_meeting", "cancel_meeting",
      "update_contact", "close_conversation", "integration_create_lead",
      "shopify.create_order", "charge_card", "delete_customer",
    ]) {
      const r = await dispatchToolCall(call(tool), SANDBOX_SAFE);
      const payload = JSON.parse(r.content);
      expect(payload.simulated, tool).toBe(true);
      expect(payload.executed, tool).toBe(false);
    }
  });

  it("blocks an unrecognised tool too - unknown means unsafe", async () => {
    const r = await dispatchToolCall(call("some_vendor_thing_we_never_saw"), SANDBOX_SAFE);
    expect(JSON.parse(r.content).simulated).toBe(true);
  });

  it("never returns an approval side effect for a simulated write", async () => {
    // A simulated action must not create an ApprovalRequest or page a human:
    // nothing happened, so there is nothing to approve.
    const r = await dispatchToolCall(call("issue_refund"), SANDBOX_SAFE);
    expect(r.sideEffect?.awaitingApproval).toBeUndefined();
    expect(r.sideEffect?.denied).toBeUndefined();
  });

  // The two non-interception cases below fall THROUGH the guard into the real
  // policy gate, which needs Redis and a database. Rather than stand that up,
  // they assert the observable thing that matters: the guard did not answer.
  // The guard returns without any I/O, so if a simulated payload has not
  // appeared almost immediately, the call went past it - which is the property
  // under test.
  const notIntercepted = async (ctx: Parameters<typeof dispatchToolCall>[1]) => {
    const guard = dispatchToolCall(call("issue_refund"), ctx)
      .then((r) => {
        try { return JSON.parse(r.content).simulated === true; } catch { return false; }
      })
      .catch(() => false);
    const timeout = new Promise<"fell-through">((res) => setTimeout(() => res("fell-through"), 400));
    return Promise.race([guard, timeout]);
  };

  // Either outcome proves non-interception: the call is still working its way
  // through the real gate ("fell-through"), or it finished without producing a
  // simulated payload (false). The only failing result is `true`.
  it("does NOT intercept when writes are set to real", async () => {
    // Opting into real execution must reach the ordinary production path
    // (policy gate, HITL, audit) - whatever that then decides.
    expect(
      await notIntercepted({ ...SANDBOX_SAFE, sandbox: { enabled: true, writes: "real" } }),
    ).not.toBe(true);
  });

  it("does NOT intercept outside sandbox mode at all", async () => {
    // Live traffic must be completely unaffected by this code existing.
    expect(
      await notIntercepted({ tenantId: "tnt_test", conversationId: "conv_test" }),
    ).not.toBe(true);
  });

  it("rejects malformed arguments before anything else", async () => {
    const r = await dispatchToolCall(
      { id: "bad", function: { name: "issue_refund", arguments: "{not json" } },
      SANDBOX_SAFE,
    );
    expect(JSON.parse(r.content).error).toMatch(/invalid JSON/i);
  });
});
