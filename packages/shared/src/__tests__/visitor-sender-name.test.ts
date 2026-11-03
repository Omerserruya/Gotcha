/**
 * A web-chat visitor sees a person's first name, never their email, and no
 * internal marker for the AI or the system (2026-11-02).
 */
import { describe, it, expect } from "vitest";
import { visitorSenderName, visitorAuthor } from "../lib/shopify-live-chat";

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

/**
 * Who wrote it, as the widget draws it (2026-11-03): a reply typed in the
 * inbox is a person's, so the widget labels it and closes "connecting you".
 */
describe("visitorAuthor", () => {
  it("an inbox reply is an agent's, by their own first name", () => {
    expect(visitorAuthor({ direction: "OUTBOUND", senderName: "tehila@shop.co.il" }, "תהילה רוזן")).toEqual({
      author: "תהילה",
      authorKind: "agent",
    });
  });
  it("without a looked-up name: the email's local part, never the email", () => {
    const got = visitorAuthor({ direction: "OUTBOUND", senderName: "dana.levi@shop.co.il" });
    expect(got.authorKind).toBe("agent");
    expect(got.author).toBe("dana levi");
  });
  it("the AI and the system are not a person", () => {
    expect(visitorAuthor({ direction: "OUTBOUND", senderName: "AI Bot" })).toEqual({ author: null, authorKind: "ai" });
    expect(visitorAuthor({ direction: "OUTBOUND", senderName: "Maya" }, "Maya Cohen").authorKind).toBe("ai");
  });
  it("the visitor's own message", () => {
    expect(visitorAuthor({ direction: "INBOUND", senderName: "x@y.z" })).toEqual({ author: null, authorKind: "visitor" });
  });
});
