/**
 * ★ A message pushed live over the socket bridge never carries the old public
 * uploads path (2026-10-10): incoming-worker's message:new arrives with the
 * stored "/api/uploads/<name>", and the bridge presents it as the logged-in
 * per-message media route, as every read does.
 */
import { describe, it, expect } from "vitest";
import { presentRelayedMessage } from "../lib/message-media";

const NAME = "0f8fad5b-d9cb-469f-a165-70867728950e.jpg";

describe("★ presentRelayedMessage", () => {
  it("a stored upload becomes the per-message media route", () => {
    const data: any = { conversationId: "c1", message: { id: "m1", conversationId: "c1", mediaUrl: `/api/uploads/${NAME}` } };
    presentRelayedMessage(data);
    expect(data.message.mediaUrl).toBe(`/api/conversations/c1/messages/m1/media/${NAME}`);
  });

  it("a Meta CDN link, a message without media and an event without a message pass untouched", () => {
    const cdn: any = { message: { id: "m2", conversationId: "c1", mediaUrl: "https://lookaside.fbsbx.com/x" } };
    presentRelayedMessage(cdn);
    expect(cdn.message.mediaUrl).toBe("https://lookaside.fbsbx.com/x");
    const text: any = { message: { id: "m3", conversationId: "c1", body: "hi" } };
    presentRelayedMessage(text);
    expect(text.message).toEqual({ id: "m3", conversationId: "c1", body: "hi" });
    const other: any = { conversationId: "c1", status: "OPEN" };
    presentRelayedMessage(other);
    expect(other).toEqual({ conversationId: "c1", status: "OPEN" });
    expect(() => presentRelayedMessage(null)).not.toThrow();
  });
});
