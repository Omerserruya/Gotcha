/**
 * What each email adapter puts on the wire when the channel's template is on
 * (thread.htmlBody set) and when it is not (2026-10-22). Providers are stubbed:
 * fetch for Gmail/Outlook, nodemailer for SMTP.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const SMTP = vi.hoisted(() => ({ mails: [] as any[] }));
vi.mock("nodemailer", () => {
  const createTransport = () => ({ sendMail: async (m: any) => { SMTP.mails.push(m); return { messageId: "m_1" }; } });
  return { default: { createTransport }, createTransport };
});

import { gmailOutboundAdapter } from "../gmail.adapter";
import { outlookOutboundAdapter } from "../outlook.adapter";
import { emailOutboundAdapter } from "../email.adapter";

const sent: Array<{ url: string; body: any }> = [];
beforeEach(() => {
  sent.length = 0;
  SMTP.mails.length = 0;
  vi.stubGlobal("fetch", async (url: any, init: any) => {
    sent.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify({ id: "g_1" }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
});

const creds = { accessToken: "at", fromAddress: "support@acme.test" } as any;
const thread = { subject: "Re: Order 1234", inReplyTo: "<c@mail.test>", references: ["<a@mail.test>", "<c@mail.test>"], threadId: "t_9" };
const TEXT = "שלום Dana,\nOn its way.";
const HTML = "<main>שלום Dana,<br>\nOn its way.</main>";

/** The decoded MIME parts of the last Gmail send. */
function gmailParts() {
  const msg = Buffer.from(sent[sent.length - 1]!.body.raw, "base64url").toString("utf8");
  const boundary = /boundary="([^"]+)"/.exec(msg)?.[1];
  const parts = boundary
    ? msg.split(`--${boundary}`).slice(1, -1).map((p) => {
      const [head, ...rest] = p.replace(/^\r\n/, "").split("\r\n\r\n");
      const body = rest.join("\r\n\r\n").replace(/\r\n/g, "");
      return { head: head!, body: Buffer.from(body, "base64").toString("utf8") };
    })
    : [];
  return { msg, parts };
}

describe("★ Gmail: multipart/alternative with BOTH parts, threading unchanged", () => {
  it("template on: text/plain first, then text/html, both utf-8", async () => {
    await gmailOutboundAdapter.sendTextMessage(creds, "support@acme.test", "buyer@x.test", TEXT, undefined, { ...thread, htmlBody: HTML });
    const { msg, parts } = gmailParts();
    expect(msg).toMatch(/Content-Type: multipart\/alternative; boundary="alt_[0-9a-f]+"/);
    expect(parts.map((p) => /Content-Type: ([^;]+)/.exec(p.head)?.[1])).toEqual(["text/plain", "text/html"]);
    expect(parts[0]!.body).toBe(TEXT);
    expect(parts[1]!.body).toBe(HTML);
    expect(msg).toContain("In-Reply-To: <c@mail.test>");
    expect(msg).toContain("References: <a@mail.test> <c@mail.test>");
    expect(sent[0]!.body.threadId).toBe("t_9");
  });

  it("template off: the same text/plain message as before", async () => {
    await gmailOutboundAdapter.sendTextMessage(creds, "support@acme.test", "buyer@x.test", TEXT, undefined, thread);
    const { msg } = gmailParts();
    expect(msg).toContain("Content-Type: text/plain; charset=utf-8");
    expect(msg).not.toContain("multipart");
    expect(msg.endsWith(TEXT)).toBe(true);
  });
});

describe("★ SMTP: nodemailer gets html beside text", () => {
  it("template on: both", async () => {
    await emailOutboundAdapter.sendTextMessage({ smtpHost: "h", smtpPort: 587 } as any, "support@acme.test", "buyer@x.test", TEXT, undefined, { ...thread, htmlBody: HTML });
    expect(SMTP.mails[0]).toMatchObject({ text: TEXT, html: HTML, subject: "Re: Order 1234" });
  });
  it("template off: text only", async () => {
    await emailOutboundAdapter.sendTextMessage({ smtpHost: "h", smtpPort: 587 } as any, "support@acme.test", "buyer@x.test", TEXT, undefined, thread);
    expect(SMTP.mails[0].html).toBeUndefined();
    expect(SMTP.mails[0].text).toBe(TEXT);
  });
});

describe("★ Outlook: one body, HTML when the template is on", () => {
  it("new mail: contentType HTML with the rendered template, threading headers kept", async () => {
    await outlookOutboundAdapter.sendTextMessage(creds, "x", "buyer@x.test", TEXT, undefined, { ...thread, htmlBody: HTML });
    const msg = sent[0]!.body.message;
    expect(msg.body).toEqual({ contentType: "HTML", content: HTML });
    expect(msg.internetMessageHeaders).toEqual([
      { name: "In-Reply-To", value: "<c@mail.test>" },
      { name: "References", value: "<a@mail.test> <c@mail.test>" },
    ]);
  });
  it("reply endpoint: the comment is the rendered template", async () => {
    await outlookOutboundAdapter.sendTextMessage(creds, "x", "buyer@x.test", TEXT, undefined, { ...thread, providerMessageId: "AAMk1", htmlBody: HTML });
    expect(sent[0]!.url).toContain("/me/messages/AAMk1/reply");
    expect(sent[0]!.body).toEqual({ comment: HTML });
  });
  it("template off: Text body / plain comment, as before", async () => {
    await outlookOutboundAdapter.sendTextMessage(creds, "x", "buyer@x.test", TEXT, undefined, thread);
    expect(sent[0]!.body.message.body).toEqual({ contentType: "Text", content: TEXT });
  });
});
