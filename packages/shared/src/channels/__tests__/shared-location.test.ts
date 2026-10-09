import { describe, it, expect } from "vitest";
import { whatsAppInboundAdapter } from "../whatsapp.adapter";
import { messengerInboundAdapter } from "../messenger.adapter";
import { sharedLocationContent } from "../types";

/**
 * ★ A shared location is a message, not "unsupported media" (2026-10-09: a
 * customer's location got an English auto-reply and the AI saw only
 * "[Location: lat, lng]").
 *   - the body names the place and its address beside the coordinates, so the
 *     AI and the inbox can read where it is
 *   - the structure (latitude, longitude, name, address, url) rides the
 *     content for metadata
 *   - a link the provider gives is kept only when it is https; otherwise one
 *     is built from the coordinates
 *   - coordinates that are not numbers never produce a location
 */
const inbound = (message: Record<string, unknown>) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "WABA", changes: [{ field: "messages", value: {
    messaging_product: "whatsapp",
    metadata: { display_phone_number: "972557773421", phone_number_id: "PNID" },
    contacts: [{ profile: { name: "GOTCHA" }, wa_id: "972552633304" }],
    messages: [message],
  } }] }],
});
const base = { from: "972552633304", id: "wamid.L", timestamp: "1787472944", type: "location" };

describe("★ WhatsApp location", () => {
  it("a named place: its name and address in the body, the structure on the content", () => {
    const [msg] = whatsAppInboundAdapter.extractMessages(inbound({
      ...base,
      location: { latitude: 29.5577, longitude: 34.9519, name: "נמל אילת", address: "דרך הנמל 1, אילת", url: "https://maps.example/eilat" },
    }));
    expect(msg.content).toEqual({
      type: "location",
      text: "[Shared location: נמל אילת, דרך הנמל 1, אילת (29.5577, 34.9519)]",
      location: { latitude: 29.5577, longitude: 34.9519, name: "נמל אילת", address: "דרך הנמל 1, אילת", url: "https://maps.example/eilat" },
    });
  });

  it("a dropped pin: the coordinates, and a map link built from them", () => {
    const [msg] = whatsAppInboundAdapter.extractMessages(inbound({ ...base, location: { latitude: 32.0853, longitude: 34.7818 } }));
    expect(msg.content).toEqual({
      type: "location",
      text: "[Shared location: (32.0853, 34.7818)]",
      location: { latitude: 32.0853, longitude: 34.7818, url: "https://www.google.com/maps?q=32.0853,34.7818" },
    });
  });

  it("coordinates that are not numbers: no location, a readable placeholder", () => {
    const [msg] = whatsAppInboundAdapter.extractMessages(inbound({ ...base, location: { latitude: "north", longitude: null } }));
    expect(msg.content).toEqual({ type: "text", text: "[Shared location]" });
  });
});

describe("★ Messenger location", () => {
  it("the attachment's coordinates and title, the same shape", () => {
    const [msg] = messengerInboundAdapter.extractMessages({
      object: "page",
      entry: [{ id: "PAGE", messaging: [{
        sender: { id: "psid_1" }, recipient: { id: "PAGE" }, timestamp: 1787472944000,
        message: { mid: "m_1", attachments: [{ type: "location", title: "Dizengoff Center", url: "http://l.facebook.com/x", payload: { coordinates: { lat: 32.0753, long: 34.7752 } } }] },
      }] }],
    });
    expect(msg.content).toEqual({
      type: "location",
      text: "[Shared location: Dizengoff Center (32.0753, 34.7752)]",
      location: { latitude: 32.0753, longitude: 34.7752, name: "Dizengoff Center", url: "https://www.google.com/maps?q=32.0753,34.7752" },
    });
  });
});

describe("sharedLocationContent", () => {
  it("numeric strings are coordinates; names are trimmed and capped", () => {
    const c = sharedLocationContent("31.5", "35.1", { name: `  ${"א".repeat(400)}  ` });
    expect(c?.location.latitude).toBe(31.5);
    expect(c?.location.name).toHaveLength(300);
  });

  it("infinite or missing coordinates are refused", () => {
    expect(sharedLocationContent(Infinity, 34)).toBeNull();
    expect(sharedLocationContent(undefined, 34)).toBeNull();
    expect(sharedLocationContent("", 34)).toBeNull();
  });
});
