import { describe, it, expect } from "vitest";
import { classifyToolEffect } from "../tool-effect";

/**
 * The sandbox write guard's correctness rests entirely on this classifier: a
 * mutating tool misread as a read would really execute during a test chat.
 * These pin the safety bias rather than the exact table.
 */
describe("classifyToolEffect - the sandbox write guard depends on this", () => {
  it("classifies obvious reads as reads", () => {
    for (const t of ["get_contact", "list_workflows", "search_products", "check_availability",
                     "shopify.get_order", "hubspot.search_contacts", "lookup_customer", "preview_broadcast"]) {
      expect(classifyToolEffect(t), t).toBe("read");
    }
  });

  it("classifies anything that changes state as an action", () => {
    for (const t of ["issue_refund", "process_refund", "apply_discount", "send_message",
                     "schedule_meeting", "cancel_meeting", "update_contact", "delete_customer",
                     "close_conversation", "escalate_to_human", "shopify.create_order",
                     "integration_create_lead", "charge_card"]) {
      expect(classifyToolEffect(t), t).toBe("action");
    }
  });

  it("treats a read-and-write name as an action", () => {
    // "get_or_create" both reads and writes; guessing "read" would let it run.
    expect(classifyToolEffect("get_or_create_contact")).toBe("action");
    expect(classifyToolEffect("find_or_create_deal")).toBe("action");
  });

  it("is safe-biased for anything it does not recognise", () => {
    for (const t of ["", "frobnicate", "do_the_thing", "x.y.z", "weird_vendor_op"]) {
      expect(classifyToolEffect(t), t).toBe("action");
    }
  });

  it("is stable across the dotted vendor form", () => {
    expect(classifyToolEffect("fireberry.update_record")).toBe("action");
    expect(classifyToolEffect("fireberry.get_record")).toBe("read");
  });
});
