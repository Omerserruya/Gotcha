import { describe, it, expect, vi, beforeEach } from "vitest";
import { whatsAppInboundAdapter } from "../whatsapp.adapter";

/**
 * Smoovee prod 2026-11-13 09:01 (cmweqxqh): the customer edited her first
 * message to add the size, "אני צריכה 49 על 32". The edit arrived as
 * `type: "edit"`, fell into the unmodelled branch, was stored as
 * "[edit message]", and the bot asked for the size she had just given.
 * An edit is the customer's corrected text now.
 */

const inbound = (message: Record<string, unknown>) => ({
  object: "whatsapp_business_account",
  entry: [{
    id: "WABA",
    changes: [{
      field: "messages",
      value: {
        messaging_product: "whatsapp",
        metadata: { display_phone_number: "972557252943", phone_number_id: "PNID" },
        contacts: [{ profile: { name: "Iris" }, wa_id: "972500000204" }],
        messages: [message],
      },
    }],
  }],
});

const EDITED = "שלום, פניתי אליכם בצאט באתר ודרך המייל ואין מענה.\nשאלתי אם יש אפשרות להתאמת גודל המשטח למידות המיקרוגל שלי. מה שמופיע באתר קטן מדי. אני צריכה 49 על 32\nמקווה לתשובה";

describe("a WhatsApp edit", () => {
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); });

  it("is the corrected text, naming the message it replaces (her payload's shape)", () => {
    const msgs = whatsAppInboundAdapter.extractMessages(inbound({
      from: "972500000204", id: "wamid.EDIT", timestamp: "1794560466", type: "edit",
      edit: { original_message_id: "wamid.ORIGINAL", message: { type: "text", text: { body: EDITED } } },
    }));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content.type).toBe("text");
    expect(msgs[0].content.text).toBe(EDITED);
    expect(msgs[0].content.text).not.toMatch(/\[edit message\]/);
    expect(msgs[0].content.edited).toEqual({ originalExternalId: "wamid.ORIGINAL" });
    expect(msgs[0].content.unsupported).toBeUndefined();
  });

  it("an edit with no text (an edited caption on media) stays unmodelled, with its raw payload", () => {
    const msgs = whatsAppInboundAdapter.extractMessages(inbound({
      from: "972500000204", id: "wamid.EDIT2", timestamp: "1794560466", type: "edit",
      edit: { original_message_id: "wamid.IMG", message: { type: "image", image: { caption: "x" } } },
    }));
    expect(msgs[0].content.text).toBe("[edit message]");
    expect(msgs[0].content.unsupported?.providerType).toBe("edit");
    expect(msgs[0].content.edited).toBeUndefined();
  });

  it("a blank edited text is not an edit", () => {
    const msgs = whatsAppInboundAdapter.extractMessages(inbound({
      from: "972500000204", id: "wamid.EDIT3", timestamp: "1794560466", type: "edit",
      edit: { original_message_id: "wamid.X", message: { type: "text", text: { body: "   " } } },
    }));
    expect(msgs[0].content.unsupported?.providerType).toBe("edit");
  });
});
