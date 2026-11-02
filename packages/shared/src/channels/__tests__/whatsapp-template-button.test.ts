/**
 * A tap on a TEMPLATE's quick-reply button arrives as type "button" (2026-11-02).
 * It used to fall to the unsupported case, so neither a campaign template's
 * buttons ("Button tapped") nor GOTCHA's approval request could be read.
 */
import { describe, it, expect } from "vitest";
import { whatsAppInboundAdapter } from "../whatsapp.adapter";

const inbound = (message: Record<string, unknown>) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "WABA", changes: [{ field: "messages", value: {
    messaging_product: "whatsapp",
    metadata: { display_phone_number: "972500000000", phone_number_id: "PNID" },
    contacts: [{ profile: { name: "Manager" }, wa_id: "972500000001" }],
    messages: [message],
  } }] }],
});

describe("template quick-reply taps", () => {
  it("read as a button reply with the payload and the button's text", () => {
    const [m] = whatsAppInboundAdapter.extractMessages(inbound({
      from: "972500000001", id: "wamid.T1", timestamp: "1730000000", type: "button",
      button: { payload: "apr_ref_123", text: "אישור" },
    }) as any);
    expect(m!.content.type).toBe("interactive");
    expect(m!.content.interactiveReply).toEqual({ type: "button", payload: "apr_ref_123", title: "אישור" });
  });
  it("an interactive reply-button is read as before", () => {
    const [m] = whatsAppInboundAdapter.extractMessages(inbound({
      from: "972500000001", id: "wamid.T2", timestamp: "1730000000", type: "interactive",
      interactive: { type: "button_reply", button_reply: { id: "ref_x", title: "Approve" } },
    }) as any);
    expect(m!.content.interactiveReply).toMatchObject({ payload: "ref_x", title: "Approve" });
  });
});
