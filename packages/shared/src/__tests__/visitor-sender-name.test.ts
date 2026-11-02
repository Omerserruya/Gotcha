/**
 * A web-chat visitor sees a person's first name, never their email, and no
 * internal marker for the AI or the system (2026-11-02).
 */
import { describe, it, expect } from "vitest";
import { visitorSenderName } from "../lib/shopify-live-chat";

describe("visitorSenderName", () => {
  it("an inbox reply: the first name, not the email", () => {
    expect(visitorSenderName("dana.levi@shop.co.il")).toBe("dana levi");
    expect(visitorSenderName("dana.levi@shop.co.il")).not.toContain("@");
  });
  it("an employee's own name is kept", () => {
    expect(visitorSenderName("Maya")).toBe("Maya");
  });
  it("the internal markers and nothing: null (the widget shows its own name)", () => {
    for (const s of ["AI Bot", "System", "Broadcast", "", null, undefined]) expect(visitorSenderName(s as any)).toBeNull();
  });
});
