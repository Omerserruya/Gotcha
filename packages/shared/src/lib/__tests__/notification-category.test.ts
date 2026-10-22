import { describe, it, expect } from "vitest";
import {
  notificationCategory, notificationTarget, NOTIFICATION_CATEGORIES,
} from "../notification-category";

describe("notificationCategory", () => {
  it("maps the four event types that genuinely have a category", () => {
    expect(notificationCategory("tool.approval_required")).toBe("APPROVAL_REQUIRED");
    expect(notificationCategory("payment.failed")).toBe("ACTION_FAILED");
    expect(notificationCategory("system.error.critical")).toBe("ACTION_FAILED");
    expect(notificationCategory("credit.auto_purchase_failed")).toBe("ACTION_FAILED");
  });

  // The coverage problem, asserted rather than described. The whole billing
  // family reaches the bell as OTHER, and OTHER is not "unimportant".
  it("does NOT invent a category for the billing family", () => {
    for (const e of [
      "invoice.issued", "invoice.paid", "subscription.past_due", "credit.exhausted",
      "payment_method.expiring", "subscription.trial_ending", "lead.created",
      "conversation.escalated", "meeting.scheduled", "refund.issued",
    ]) {
      expect(notificationCategory(e)).toBe("OTHER");
    }
  });

  it("never returns a value outside the domain", () => {
    for (const e of ["", "   ", null, undefined, "totally.made.up"]) {
      expect(NOTIFICATION_CATEGORIES).toContain(notificationCategory(e as any));
    }
  });

  it("passes a stored category through, so backfilled rows still classify", () => {
    expect(notificationCategory("APPROVAL_REQUIRED")).toBe("APPROVAL_REQUIRED");
    expect(notificationCategory("ACTION_FAILED")).toBe("ACTION_FAILED");
  });
});

describe("notificationTarget", () => {
  it("points an approval notification at the approval", () => {
    expect(notificationTarget("tool.approval_required", { approvalRequestId: "apr_1" }))
      .toEqual({ targetType: "approval", targetId: "apr_1" });
  });

  it("prefers the approval over a conversation that is also present", () => {
    // Both ids ride on the same event; the actionable one is the approval.
    expect(notificationTarget("tool.approval_required", { approvalRequestId: "apr_1", conversationId: "c1" }))
      .toEqual({ targetType: "approval", targetId: "apr_1" });
  });

  it("falls back to the conversation for events that only carry one", () => {
    expect(notificationTarget("conversation.escalated", { conversationId: "c1" }))
      .toEqual({ targetType: "conversation", targetId: "c1" });
  });

  it("returns an explicit none rather than a null nobody got to", () => {
    expect(notificationTarget("invoice.issued", {})).toEqual({ targetType: "none", targetId: null });
    expect(notificationTarget("invoice.issued", null)).toEqual({ targetType: "none", targetId: null });
  });

  it("ignores blank and non-string ids", () => {
    expect(notificationTarget("conversation.escalated", { conversationId: "   " }))
      .toEqual({ targetType: "none", targetId: null });
    expect(notificationTarget("conversation.escalated", { conversationId: 42 as any }))
      .toEqual({ targetType: "none", targetId: null });
  });
});
