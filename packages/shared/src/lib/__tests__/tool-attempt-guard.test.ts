import { describe, it, expect, beforeEach } from "vitest";
import {
  checkToolAttempt,
  recordToolAttempt,
  attemptKey,
  failureClass,
  __resetToolAttemptGuard,
} from "../tool-attempt-guard";

/**
 * The four-call loop, replayed.
 *
 * 12:39  update_order_fulfillment {order_id:"#1006", note:"..."}          400
 * 12:41  update_order_fulfillment {order_id:"#1006", tag, note:"..."}     400
 * 12:42  update_order_fulfillment {order_id:"#1006", tag, note:"..."}     400
 * 12:44  update_order_fulfillment {order_id:"1006",  tag, note:"..."}     404
 *
 * Five minutes, one order, four failures, and between them the customer was
 * told a shipping team was being contacted. He asked to cancel.
 *
 * The note and tag text changed on every retry, so a whole-payload comparison
 * would have called these four different calls. The guard keys on the TARGET.
 */

const CONV = "conv_matan";
const TOOL = "shopify.update_order_fulfillment";

beforeEach(() => __resetToolAttemptGuard());

describe("the production sequence is stopped", () => {
  it("allows two attempts and refuses the third", () => {
    const attempts = [
      { order_id: "#1006", note: "Customer requested shipping ETA and tracking." },
      { order_id: "#1006", tag: "investigate_shipment", note: "Please investigate." },
      { order_id: "#1006", tag: "shipping-investigation", note: "Mark as high priority." },
      { order_id: "1006", tag: "urgent_shipment_check", note: "flagged for urgent ops follow-up." },
    ];
    const verdicts: boolean[] = [];

    for (const args of attempts) {
      const v = checkToolAttempt(CONV, TOOL, args);
      verdicts.push(v.allowed);
      if (v.allowed) {
        recordToolAttempt(CONV, TOOL, args, {
          ok: false,
          reason: args.order_id === "1006" ? "shopify_404: Not Found" : "shopify_400: id: expected String to be a id",
        });
      }
    }

    expect(verdicts, "two tries, then refuse").toEqual([true, true, false, false]);
  });

  it("explains itself to the model without inviting a retry", () => {
    for (let i = 0; i < 2; i++) {
      recordToolAttempt(CONV, TOOL, { order_id: "#1006" }, { ok: false, reason: "shopify_400" });
    }
    const v = checkToolAttempt(CONV, TOOL, { order_id: "#1006" });
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/Do not call it again/);
    expect(v.reason).toMatch(/hand over to a human|tell the customer/);
    // The specific harm from the real conversation.
    expect(v.reason).toMatch(/Do NOT claim this action succeeded or that anyone was contacted/);
  });

  it("treats '#1006' and '1006' as the same target", () => {
    // The model's fourth attempt dropped the '#'. Under a naive key that would
    // have looked like a fresh target and bought two more attempts.
    recordToolAttempt(CONV, TOOL, { order_id: "#1006" }, { ok: false, reason: "shopify_400" });
    recordToolAttempt(CONV, TOOL, { order_id: " 1006 " }, { ok: false, reason: "shopify_404" });
    expect(checkToolAttempt(CONV, TOOL, { order_name: "1006" }).allowed).toBe(false);
  });

  it("ignores the changing note and tag text", () => {
    recordToolAttempt(CONV, TOOL, { order_id: "#1006", note: "first wording" }, { ok: false, reason: "shopify_400" });
    recordToolAttempt(CONV, TOOL, { order_id: "#1006", note: "completely different wording", tag: "x" }, { ok: false, reason: "shopify_400" });
    expect(checkToolAttempt(CONV, TOOL, { order_id: "#1006", note: "third wording", tag: "y" }).allowed).toBe(false);
  });
});

describe("it does not block work that should proceed", () => {
  it("lets a different order through", () => {
    for (let i = 0; i < 3; i++) {
      recordToolAttempt(CONV, TOOL, { order_id: "#1006" }, { ok: false, reason: "shopify_400" });
    }
    expect(checkToolAttempt(CONV, TOOL, { order_name: "#1007" }).allowed).toBe(true);
  });

  it("lets a different tool through for the same order", () => {
    for (let i = 0; i < 3; i++) {
      recordToolAttempt(CONV, TOOL, { order_id: "#1006" }, { ok: false, reason: "shopify_400" });
    }
    expect(checkToolAttempt(CONV, "shopify.get_order", { order_name: "#1006" }).allowed).toBe(true);
  });

  it("keeps conversations separate", () => {
    for (let i = 0; i < 3; i++) {
      recordToolAttempt(CONV, TOOL, { order_id: "#1006" }, { ok: false, reason: "shopify_400" });
    }
    expect(checkToolAttempt("another_conv", TOOL, { order_id: "#1006" }).allowed).toBe(true);
  });

  it("clears the tally after a success", () => {
    // Whatever was wrong is not wrong any more.
    recordToolAttempt(CONV, TOOL, { order_id: "#1006" }, { ok: false, reason: "shopify_400" });
    recordToolAttempt(CONV, TOOL, { order_id: "#1006" }, { ok: false, reason: "shopify_400" });
    expect(checkToolAttempt(CONV, TOOL, { order_id: "#1006" }).allowed).toBe(false);

    recordToolAttempt(CONV, TOOL, { order_id: "#1006" }, { ok: true });
    expect(checkToolAttempt(CONV, TOOL, { order_id: "#1006" }).allowed).toBe(true);
  });

  it("gives a DIFFERENT failure its own budget", () => {
    // Fixing a bad-argument error should not leave the call blocked by the
    // tally from the previous problem.
    recordToolAttempt(CONV, TOOL, { order_id: "#1006" }, { ok: false, reason: "note_or_tag_required" });
    recordToolAttempt(CONV, TOOL, { order_id: "#1006" }, { ok: false, reason: "note_or_tag_required" });
    expect(checkToolAttempt(CONV, TOOL, { order_id: "#1006" }).allowed).toBe(false);

    recordToolAttempt(CONV, TOOL, { order_id: "#1006" }, { ok: false, reason: "shopify_429 rate limited" });
    expect(checkToolAttempt(CONV, TOOL, { order_id: "#1006" }).allowed).toBe(true);
  });

  it("does nothing without a conversation id", () => {
    // Copilot / one-off calls have no conversation to scope a loop to.
    for (let i = 0; i < 5; i++) {
      recordToolAttempt(undefined, TOOL, { order_id: "#1006" }, { ok: false, reason: "shopify_400" });
    }
    expect(checkToolAttempt(undefined, TOOL, { order_id: "#1006" }).allowed).toBe(true);
  });
});

describe("failure classification", () => {
  it("puts the production 400 and 404 in one class", () => {
    // Two messages, one problem: the identifier does not resolve.
    expect(failureClass("shopify_400: id: expected String to be a id")).toBe("target_not_resolvable");
    expect(failureClass("shopify_404: Not Found")).toBe("target_not_resolvable");
  });

  it("separates the classes that need different responses", () => {
    expect(failureClass("shopify_403 missing write_orders scope")).toBe("not_permitted");
    expect(failureClass("shopify_429 rate limited")).toBe("rate_limited");
    expect(failureClass("shopify_503 service unavailable")).toBe("provider_unavailable");
    expect(failureClass("note_or_tag_required")).toBe("bad_arguments");
  });
});

describe("the attempt key", () => {
  it("normalises the order reference", () => {
    const a = attemptKey(TOOL, { order_id: "#1006" });
    expect(attemptKey(TOOL, { order_name: "1006" })).toBe(a);
    expect(attemptKey(TOOL, { order_id: " #1006 " })).toBe(a);
  });

  it("keeps distinct targets distinct", () => {
    expect(attemptKey(TOOL, { order_id: "#1006" })).not.toBe(attemptKey(TOOL, { order_id: "#1007" }));
    expect(attemptKey(TOOL, { order_id: "#1006" })).not.toBe(attemptKey("shopify.cancel_order", { order_id: "#1006" }));
  });
});
