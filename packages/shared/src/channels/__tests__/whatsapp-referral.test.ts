import { describe, it, expect } from "vitest";
import { whatsAppInboundAdapter } from "../whatsapp.adapter";

/**
 * Click-to-WhatsApp: Meta names the ad ONCE, on the customer's first message.
 *
 * Miss it and the origin of a lead the business paid for is unknowable
 * afterwards - there is no API to ask "where did this conversation come from"
 * later. These tests pin that it survives, including the sparse shapes Meta
 * actually sends.
 */
const inbound = (message: Record<string, unknown>) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "WABA", changes: [{ field: "messages", value: {
    messaging_product: "whatsapp",
    metadata: { display_phone_number: "972500000000", phone_number_id: "PNID" },
    contacts: [{ profile: { name: "לקוחה" }, wa_id: "972500000001" }],
    messages: [message],
  } }] }],
});

const base = { from: "972500000001", id: "wamid.A", timestamp: "1787472944", type: "text", text: { body: "היי" } };

describe("referral on an inbound message", () => {
  it("keeps the ad's identity and its words", () => {
    const [msg] = whatsAppInboundAdapter.extractMessages(inbound({
      ...base,
      referral: {
        source_url: "https://fb.me/ad", source_id: "120210000000000000", source_type: "ad",
        headline: "ברית בסוף השבוע?", body: "יש לנו תאריכים", ctwa_clid: "clid_abc",
      },
    }));
    expect(msg.referral).toEqual({
      sourceType: "ad", sourceId: "120210000000000000", sourceUrl: "https://fb.me/ad",
      headline: "ברית בסוף השבוע?", body: "יש לנו תאריכים", ctwaClid: "clid_abc", mediaUrl: undefined,
    });
  });

  it("keeps a sparse referral - an ad id alone still answers 'came from an ad'", () => {
    const [msg] = whatsAppInboundAdapter.extractMessages(inbound({ ...base, referral: { source_id: "120210000000000000" } }));
    expect(msg.referral?.sourceId).toBe("120210000000000000");
    expect(msg.referral?.headline).toBeUndefined();
  });

  it("treats an empty referral object as no referral", () => {
    const [msg] = whatsAppInboundAdapter.extractMessages(inbound({ ...base, referral: {} }));
    expect(msg.referral).toBeUndefined();
  });

  it("leaves an ordinary message alone", () => {
    const [msg] = whatsAppInboundAdapter.extractMessages(inbound(base));
    expect(msg.referral).toBeUndefined();
  });
});

describe("referral_conversion on delivery statuses", () => {
  const status = (extra: Record<string, unknown>) => ({
    object: "whatsapp_business_account",
    entry: [{ id: "WABA", changes: [{ field: "messages", value: {
      messaging_product: "whatsapp",
      metadata: { display_phone_number: "972500000000", phone_number_id: "PNID" },
      statuses: [{ id: "wamid.OUT", status: "delivered", timestamp: "1787472944", recipient_id: "972500000001", ...extra }],
    } }] }],
  });

  // This is the fallback that identifies a conversation whose first message we
  // never saw - exactly the production case that started this.
  it("surfaces conversation.origin.type", () => {
    const [s] = whatsAppInboundAdapter.extractStatusUpdates(status({ conversation: { id: "c1", origin: { type: "referral_conversion" } } }));
    expect(s.conversationOrigin).toBe("referral_conversion");
  });

  it("falls back to pricing.category when origin is absent", () => {
    const [s] = whatsAppInboundAdapter.extractStatusUpdates(status({ pricing: { billable: false, category: "referral_conversion" } }));
    expect(s.conversationOrigin).toBe("referral_conversion");
  });

  it("is undefined for an ordinary delivery", () => {
    const [s] = whatsAppInboundAdapter.extractStatusUpdates(status({ conversation: { id: "c1", origin: { type: "service" } } }));
    expect(s.conversationOrigin).toBe("service");
  });
});
