/**
 * What the Gmail adapter actually puts on the wire.
 *
 * The threading helpers are tested on their own; this is the half that used to
 * be wrong in production: the adapter hard-coded `Subject: "Message"` and set
 * no In-Reply-To, no References and no threadId, so a support reply arrived as
 * a new email called "Message" instead of under the customer's question.
 *
 * Everything is asserted against the decoded RFC 5322 message, because the raw
 * base64url blob is the only thing Gmail ever sees.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { gmailOutboundAdapter, fetchNewMessages } from "../gmail.adapter";
import type { ChannelCredentials } from "../types";

const creds = { accessToken: "at_1", fromAddress: "support@acme.test" } as unknown as ChannelCredentials;

const sent: Array<{ url: string; body: any }> = [];

function decodeRaw(raw: string): string {
  return Buffer.from(raw, "base64url").toString("utf8");
}

/** The decoded message from the most recent send. */
function lastMessage(): string {
  return decodeRaw(sent[sent.length - 1].body.raw);
}

function headerOf(message: string, name: string): string | undefined {
  const line = message
    .split("\r\n")
    .find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  return line?.slice(name.length + 1).trim();
}

beforeEach(() => {
  sent.length = 0;
  vi.stubGlobal("fetch", async (url: any, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    sent.push({ url: String(url), body });
    return new Response(JSON.stringify({ id: "sent_1" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
});

// ─── Replying ───────────────────────────────────────────────

const thread = {
  subject: "Re: Order 1234",
  inReplyTo: "<customer@mail.test>",
  references: ["<first@mail.test>", "<customer@mail.test>"],
  threadId: "t_99",
};

describe("replying to a thread", () => {
  it("sends the reply subject, not a hard-coded one", async () => {
    await gmailOutboundAdapter.sendTextMessage(creds, "support@acme.test", "buyer@x.test", "On its way.", undefined, thread);
    expect(headerOf(lastMessage(), "Subject")).toBe("Re: Order 1234");
  });

  it("carries In-Reply-To and References, which is what other mail clients read", async () => {
    await gmailOutboundAdapter.sendTextMessage(creds, "support@acme.test", "buyer@x.test", "On its way.", undefined, thread);
    const msg = lastMessage();
    expect(headerOf(msg, "In-Reply-To")).toBe("<customer@mail.test>");
    expect(headerOf(msg, "References")).toBe("<first@mail.test> <customer@mail.test>");
  });

  it("sends Gmail's own threadId alongside the headers", async () => {
    // The headers thread it everywhere else; threadId threads it at Gmail.
    // Sending one without the other threads on one side only.
    await gmailOutboundAdapter.sendTextMessage(creds, "support@acme.test", "buyer@x.test", "On its way.", undefined, thread);
    expect(sent[0].body.threadId).toBe("t_99");
  });

  it("threads the HTML variant the same way", async () => {
    await gmailOutboundAdapter.sendInteractiveMessage(
      creds, "support@acme.test", "buyer@x.test", "Pick one", [{ id: "a", title: "Yes" }], thread,
    );
    const msg = lastMessage();
    expect(headerOf(msg, "Subject")).toBe("Re: Order 1234");
    expect(headerOf(msg, "In-Reply-To")).toBe("<customer@mail.test>");
    expect(sent[0].body.threadId).toBe("t_99");
  });
});

// ─── A fresh email ──────────────────────────────────────────

describe("sending a new email", () => {
  it("carries no threading headers at all", async () => {
    // The whole point of "send as new email".
    await gmailOutboundAdapter.sendTextMessage(creds, "support@acme.test", "buyer@x.test", "A separate matter.", undefined, {
      subject: "Your renewal",
    });
    const msg = lastMessage();
    expect(headerOf(msg, "In-Reply-To")).toBeUndefined();
    expect(headerOf(msg, "References")).toBeUndefined();
    expect(sent[0].body.threadId).toBeUndefined();
    expect(headerOf(msg, "Subject")).toBe("Your renewal");
  });

  it("no longer titles an untitled email 'Message'", async () => {
    // The old hard-coded subject. It told the customer nothing and read as spam.
    await gmailOutboundAdapter.sendTextMessage(creds, "support@acme.test", "buyer@x.test", "Hello.");
    expect(headerOf(lastMessage(), "Subject")).not.toBe("Message");
    expect(headerOf(lastMessage(), "Subject")).toBe("Message from support");
  });
});

// ─── Header safety ──────────────────────────────────────────

describe("subject encoding", () => {
  it("encodes a Hebrew subject rather than writing it raw into an ASCII header", async () => {
    await gmailOutboundAdapter.sendTextMessage(creds, "support@acme.test", "buyer@x.test", "שלום", undefined, {
      subject: "Re: הזמנה 1234",
    });
    const subject = headerOf(lastMessage(), "Subject")!;
    expect(subject.startsWith("=?UTF-8?B?")).toBe(true);
    expect(Buffer.from(subject.slice(10, -2), "base64").toString("utf8")).toBe("Re: הזמנה 1234");
  });

  it("leaves a plain ASCII subject readable", async () => {
    await gmailOutboundAdapter.sendTextMessage(creds, "support@acme.test", "buyer@x.test", "hi", undefined, {
      subject: "Re: Order 1234",
    });
    expect(headerOf(lastMessage(), "Subject")).toBe("Re: Order 1234");
  });

  it("cannot be used to inject a header through a newline in the subject", async () => {
    // The attack is a CRLF in the subject turning the rest of it into a header
    // of its own. Collapsing the newline keeps the text harmlessly inside the
    // Subject value, which is why the assertion is about header LINES rather
    // than about the string appearing anywhere.
    await gmailOutboundAdapter.sendTextMessage(creds, "support@acme.test", "buyer@x.test", "hi", undefined, {
      subject: "Order\r\nBcc: attacker@evil.test",
    });
    const msg = lastMessage();
    const headerLines = msg.split("\r\n\r\n")[0].split("\r\n");

    expect(headerOf(msg, "Bcc")).toBeUndefined();
    expect(headerLines.some((l) => l.startsWith("Bcc:"))).toBe(false);
    expect(headerOf(msg, "Subject")).toBe("Order Bcc: attacker@evil.test");
  });
});

// ─── Inbound capture ────────────────────────────────────────

describe("recording a thread on the way in", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", async (url: any) => {
      const u = String(url);
      if (u.includes("/history?")) {
        return new Response(
          JSON.stringify({
            historyId: "200",
            history: [{ messagesAdded: [{ message: { id: "m1", labelIds: ["INBOX"] } }] }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          id: "m1",
          threadId: "t_42",
          snippet: "Where is my order?",
          payload: {
            headers: [
              { name: "From", value: "Dana Buyer <buyer@x.test>" },
              { name: "Subject", value: "Order 1234" },
              // Lower-case on purpose: Gmail returns "Message-Id" for some
              // senders, and an exact match on "Message-ID" would silently drop
              // threading for every one of them.
              { name: "Message-Id", value: "<customer@mail.test>" },
              { name: "References", value: "<first@mail.test>" },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
  });

  it("captures everything a later reply needs", async () => {
    const { messages } = await fetchNewMessages(creds, "100", "support@acme.test");

    expect(messages).toHaveLength(1);
    expect(messages[0].email).toEqual({
      messageIdHeader: "<customer@mail.test>",
      references: ["<first@mail.test>"],
      subject: "Order 1234",
      threadId: "t_42",
      providerMessageId: "m1",
    });
  });

  it("asks Gmail for the threading headers, which nothing else would return", async () => {
    const calls: string[] = [];
    const inner = globalThis.fetch as any;
    vi.stubGlobal("fetch", async (url: any, init: any) => { calls.push(String(url)); return inner(url, init); });

    await fetchNewMessages(creds, "100", "support@acme.test");

    const metaCall = calls.find((c) => c.includes("format=metadata"))!;
    expect(metaCall).toContain("metadataHeaders=Message-ID");
    expect(metaCall).toContain("metadataHeaders=References");
    expect(metaCall).toContain("metadataHeaders=In-Reply-To");
  });
});
