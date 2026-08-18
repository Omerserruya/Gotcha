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

describe("shared contacts", () => {
  function contactsPayload(contacts: unknown) {
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
                messages: [
                  {
                    from: "972541111111",
                    id: "wamid.CONTACT",
                    timestamp: "1760000000",
                    type: "contacts",
                    contacts,
                  },
                ],
              },
            },
          ],
        },
      ],
    };
  }

  it("keeps the number, the name and the wa_id", () => {
    // The entire point of a shared contact is that somebody can ring it. Before
    // this it rendered as the dead string "[contacts message]" and the number
    // was not stored anywhere at all.
    const [msg] = whatsAppInboundAdapter.extractMessages(
      contactsPayload([
        {
          name: { formatted_name: "Dana Levi", first_name: "Dana" },
          phones: [{ phone: "+972 54-111-2222", type: "MOBILE", wa_id: "972541112222" }],
          emails: [{ email: "dana@example.com", type: "WORK" }],
          org: { company: "Levi Events" },
        },
      ]),
    );
    expect(msg.content.type).toBe("contact");
    expect(msg.content.contacts).toHaveLength(1);
    expect(msg.content.contacts![0]).toMatchObject({
      name: "Dana Levi",
      organization: "Levi Events",
    });
    expect(msg.content.contacts![0].phones[0]).toMatchObject({
      number: "+972 54-111-2222",
      waId: "972541112222",
    });
    expect(msg.content.contacts![0].emails[0].address).toBe("dana@example.com");
  });

  it("builds a name when Meta sends only the parts", () => {
    const [msg] = whatsAppInboundAdapter.extractMessages(
      contactsPayload([
        { name: { first_name: "Noa", last_name: "Cohen" }, phones: [{ phone: "0501234567" }] },
      ]),
    );
    expect(msg.content.contacts![0].name).toBe("Noa Cohen");
  });

  it("summarizes several contacts without losing any of them", () => {
    const [msg] = whatsAppInboundAdapter.extractMessages(
      contactsPayload([
        { name: { formatted_name: "A" }, phones: [{ phone: "1" }] },
        { name: { formatted_name: "B" }, phones: [{ phone: "2" }] },
        { name: { formatted_name: "C" }, phones: [{ phone: "3" }] },
      ]),
    );
    expect(msg.content.contacts).toHaveLength(3);
    // The body is what an inbox list and a push notification show.
    expect(msg.content.text).toBe("A +2");
  });

  it("drops entries with nothing usable in them", () => {
    const [msg] = whatsAppInboundAdapter.extractMessages(
      contactsPayload([{ name: {}, phones: [], emails: [] }, { name: { formatted_name: "Real" } }]),
    );
    expect(msg.content.contacts).toHaveLength(1);
    expect(msg.content.contacts![0].name).toBe("Real");
  });

  it("does not carry the address book Meta also sends", () => {
    // Meta's payload is a full vCard: addresses, urls, birthdays. Copying it
    // wholesale would put a customer's relatives' home addresses in our
    // database for no benefit to anyone answering the message.
    const [msg] = whatsAppInboundAdapter.extractMessages(
      contactsPayload([
        {
          name: { formatted_name: "Dana" },
          phones: [{ phone: "1" }],
          addresses: [{ street: "Somewhere 4", city: "Haifa" }],
          birthday: "1990-01-01",
          urls: [{ url: "https://example.com" }],
        },
      ]),
    );
    const card = msg.content.contacts![0] as Record<string, unknown>;
    expect(Object.keys(card).sort()).toEqual(["emails", "name", "organization", "phones"]);
  });

  it("falls back to a plain label when the array is empty or malformed", () => {
    for (const payload of [[], null, "nonsense"]) {
      const [msg] = whatsAppInboundAdapter.extractMessages(contactsPayload(payload));
      expect(msg.content.text).toBe("[Contact]");
    }
  });
});
