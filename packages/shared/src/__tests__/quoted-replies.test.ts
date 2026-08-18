import { describe, it, expect } from "vitest";
import { whatsAppInboundAdapter, whatsAppOutboundAdapter } from "../channels/whatsapp.adapter";
import { instagramInboundAdapter } from "../channels/instagram.adapter";
import { messengerInboundAdapter } from "../channels/messenger.adapter";

/**
 * Quoted replies.
 *
 * A customer replying to one specific message is the difference between a
 * readable thread and a guess. "Yes, that one works" against a list of four
 * dates is a coin flip for a human agent, and worse for the AI, which will
 * confidently attach it to the most recent thing it said.
 *
 * The id is the whole feature. If it is dropped at the adapter, nothing
 * downstream can recover it - the payload is gone.
 */

function waMessage(extra: Record<string, unknown> = {}) {
  return {
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
                {
                  from: "972541111111",
                  id: "wamid.REPLY",
                  timestamp: "1760000000",
                  type: "text",
                  text: { body: "yes, that one works" },
                  ...extra,
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe("WhatsApp", () => {
  it("captures the quoted message id", () => {
    const [msg] = whatsAppInboundAdapter.extractMessages(
      waMessage({ context: { from: "972500000000", id: "wamid.ORIGINAL" } }),
    );
    expect(msg.replyToExternalId).toBe("wamid.ORIGINAL");
  });

  it("leaves it undefined on a message that is not a reply", () => {
    const [msg] = whatsAppInboundAdapter.extractMessages(waMessage());
    expect(msg.replyToExternalId).toBeUndefined();
  });

  it("takes the id from a forwarded context and ignores the rest", () => {
    // `context` also appears when a message follows a business-initiated
    // template, with `forwarded` set. The id still points at a real message,
    // so it is taken; nothing else in the object is read.
    const [msg] = whatsAppInboundAdapter.extractMessages(
      waMessage({ context: { forwarded: true, id: "wamid.SOURCE" } }),
    );
    expect(msg.replyToExternalId).toBe("wamid.SOURCE");
  });

  it("does not invent an id from an empty context", () => {
    const [msg] = whatsAppInboundAdapter.extractMessages(waMessage({ context: {} }));
    expect(msg.replyToExternalId).toBeUndefined();
  });

  it("still carries the reply's own content", () => {
    const [msg] = whatsAppInboundAdapter.extractMessages(
      waMessage({ context: { id: "wamid.ORIGINAL" } }),
    );
    expect(msg.externalMessageId).toBe("wamid.REPLY");
    expect(msg.content.text).toBe("yes, that one works");
  });
});

describe("Instagram and Messenger", () => {
  it("captures Meta's reply_to.mid on Instagram", () => {
    const [msg] = instagramInboundAdapter.extractMessages({
      object: "instagram",
      entry: [
        {
          id: "IG_1",
          time: 1760000000000,
          messaging: [
            {
              sender: { id: "IGSID_1" },
              recipient: { id: "IG_1" },
              timestamp: 1760000000000,
              message: {
                mid: "ig_reply",
                text: "this one",
                reply_to: { mid: "ig_original" },
              },
            },
          ],
        },
      ],
    });
    expect(msg.replyToExternalId).toBe("ig_original");
  });

  it("captures it on Messenger", () => {
    const [msg] = messengerInboundAdapter.extractMessages({
      object: "page",
      entry: [
        {
          id: "PAGE_1",
          messaging: [
            {
              sender: { id: "PSID_1" },
              recipient: { id: "PAGE_1" },
              timestamp: 1760000000000,
              message: { mid: "m_reply", text: "that one", reply_to: { mid: "m_original" } },
            },
          ],
        },
      ],
    });
    expect(msg.replyToExternalId).toBe("m_original");
  });

  it("leaves it undefined when the customer did not quote anything", () => {
    const [msg] = messengerInboundAdapter.extractMessages({
      object: "page",
      entry: [
        {
          id: "PAGE_1",
          messaging: [
            {
              sender: { id: "PSID_1" },
              recipient: { id: "PAGE_1" },
              timestamp: 1760000000000,
              message: { mid: "m1", text: "hello" },
            },
          ],
        },
      ],
    });
    expect(msg.replyToExternalId).toBeUndefined();
  });
});

describe("sending a reply", () => {
  it("is a normal send when nothing is quoted", async () => {
    // Verified through the request the adapter builds rather than by mocking
    // its internals: `context` must be ABSENT, not null or empty. Meta rejects
    // a context with an id it cannot resolve, and an empty object is one.
    const calls: any[] = [];
    const axios = (await import("axios")).default;
    const original = axios.post;
    (axios as any).post = async (_url: string, payload: any) => {
      calls.push(payload);
      return { data: { messages: [{ id: "wamid.SENT" }] } };
    };
    try {
      await whatsAppOutboundAdapter.sendTextMessage(
        { accessToken: "t" } as any,
        "PN_1",
        "972541111111",
        "hello",
      );
      expect(calls[0].context).toBeUndefined();

      await whatsAppOutboundAdapter.sendTextMessage(
        { accessToken: "t" } as any,
        "PN_1",
        "972541111111",
        "hello",
        "wamid.ORIGINAL",
      );
      expect(calls[1].context).toEqual({ message_id: "wamid.ORIGINAL" });
    } finally {
      (axios as any).post = original;
    }
  });
});
