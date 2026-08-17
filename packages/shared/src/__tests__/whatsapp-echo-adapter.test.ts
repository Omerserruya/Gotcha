import { describe, it, expect } from "vitest";
import { whatsAppInboundAdapter } from "../channels/whatsapp.adapter";

/**
 * Coexistence echo parsing: a number that runs in both the WhatsApp Business
 * app and the Cloud API. Meta mirrors what the owner types on their phone to
 * our webhook under `smb_message_echoes`.
 *
 * The two properties worth pinning are the ones a naive implementation gets
 * wrong: the conversation key is the echo's `to` (not `from`, which is our own
 * business number), and an echo must never surface as an inbound customer
 * message.
 */

const ECHO_PAYLOAD = {
  object: "whatsapp_business_account",
  entry: [
    {
      id: "WABA_1",
      changes: [
        {
          field: "smb_message_echoes",
          value: {
            messaging_product: "whatsapp",
            metadata: { display_phone_number: "972500000000", phone_number_id: "PN_1" },
            message_echoes: [
              {
                from: "972500000000",
                to: "972541111111",
                id: "wamid.ECHO1",
                timestamp: "1760000000",
                type: "text",
                text: { body: "אני מטפל בזה, מדבר עומר" },
              },
            ],
          },
        },
      ],
    },
  ],
};

const INBOUND_PAYLOAD = {
  object: "whatsapp_business_account",
  entry: [
    {
      id: "WABA_1",
      changes: [
        {
          field: "messages",
          value: {
            metadata: { phone_number_id: "PN_1" },
            contacts: [{ profile: { name: "Dana" } }],
            messages: [
              { from: "972541111111", id: "wamid.IN1", timestamp: "1760000001", type: "text", text: { body: "hi" } },
            ],
          },
        },
      ],
    },
  ],
};

describe("WhatsApp adapter - business-app echoes (Coexistence)", () => {
  it("keys the echo to the CUSTOMER it was sent to, not the business number", () => {
    const echoes = whatsAppInboundAdapter.extractOutboundEchoes!(ECHO_PAYLOAD);

    expect(echoes).toHaveLength(1);
    expect(echoes[0].customerExternalId).toBe("972541111111");
    expect(echoes[0].businessExternalId).toBe("972500000000");
    expect(echoes[0].externalMessageId).toBe("wamid.ECHO1");
    expect(echoes[0].content).toEqual({ type: "text", text: "אני מטפל בזה, מדבר עומר" });
  });

  it("never surfaces an echo as an inbound customer message", () => {
    // This is the whole point of the separate extractor. If echoes leaked into
    // extractMessages the bot would answer the owner's own reply.
    expect(whatsAppInboundAdapter.extractMessages(ECHO_PAYLOAD)).toEqual([]);
    expect(whatsAppInboundAdapter.extractStatusUpdates(ECHO_PAYLOAD)).toEqual([]);
  });

  it("resolves the channel account from an echo-only payload", () => {
    // Without this the webhook bails at "no channel account" and the echo is
    // dropped before any handler runs - a silent, log-free data loss.
    expect(whatsAppInboundAdapter.resolveChannelAccountExternalId(ECHO_PAYLOAD)).toBe("PN_1");
  });

  it("still resolves and parses ordinary inbound traffic", () => {
    expect(whatsAppInboundAdapter.resolveChannelAccountExternalId(INBOUND_PAYLOAD)).toBe("PN_1");
    expect(whatsAppInboundAdapter.extractMessages(INBOUND_PAYLOAD)).toHaveLength(1);
    expect(whatsAppInboundAdapter.extractOutboundEchoes!(INBOUND_PAYLOAD)).toEqual([]);
  });

  it("ignores `message_echoes` (Cloud API sends) so our own replies are not double-posted", () => {
    const apiEcho = JSON.parse(JSON.stringify(ECHO_PAYLOAD));
    apiEcho.entry[0].changes[0].field = "message_echoes";

    expect(whatsAppInboundAdapter.extractOutboundEchoes!(apiEcho)).toEqual([]);
  });

  it("carries media through so an image sent from the phone is resolvable", () => {
    const mediaEcho = JSON.parse(JSON.stringify(ECHO_PAYLOAD));
    mediaEcho.entry[0].changes[0].value.message_echoes[0] = {
      from: "972500000000",
      to: "972541111111",
      id: "wamid.ECHO2",
      timestamp: "1760000002",
      type: "image",
      image: { id: "MEDIA_9", caption: "the receipt" },
    };

    const [echo] = whatsAppInboundAdapter.extractOutboundEchoes!(mediaEcho);
    expect(echo.content).toEqual({ type: "image", mediaUrl: "MEDIA_9", caption: "the receipt" });
  });

  it("drops malformed echoes instead of writing a conversation keyed to undefined", () => {
    const broken = JSON.parse(JSON.stringify(ECHO_PAYLOAD));
    broken.entry[0].changes[0].value.message_echoes = [
      { from: "972500000000", id: "wamid.NO_TO", timestamp: "1760000003", type: "text", text: { body: "x" } },
      { to: "972541111111", timestamp: "1760000004", type: "text", text: { body: "y" } },
    ];

    expect(whatsAppInboundAdapter.extractOutboundEchoes!(broken)).toEqual([]);
  });
});
